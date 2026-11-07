import { createServer, type Server, type Socket } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { CU_CODE, CuRpcError, CuUnavailable, cuAct, cuHealth, cuResolve, resetCuHealthCache } from './computerUse'

/**
 * The client is exercised against a real Unix socket and a real server, because
 * the parts most likely to break are the parts a mock would paper over: the
 * newline framing, the `close` before a reply, and the socket path itself.
 *
 * Nothing here talks to the developer's own service — `cuHealth` refuses to run
 * under Vitest unless the socket is redirected, and every test redirects it to a
 * temporary directory.
 */
let directory = ''
let server: Server | null = null
let socketPath = ''
const received: Array<{ method: string; params: Record<string, unknown> }> = []
let reply: (request: { method: string; params: Record<string, unknown> }) => string | null = () => null

function startServer(onRequest?: (socket: Socket) => void): Promise<void> {
  server = createServer((socket) => {
    if (onRequest) {
      onRequest(socket)
      return
    }
    let buffer = ''
    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => {
      buffer += chunk
      const newline = buffer.indexOf('\n')
      if (newline < 0) return
      const request = JSON.parse(buffer.slice(0, newline))
      received.push({ method: request.method, params: request.params })
      const body = reply(request)
      if (body !== null) socket.write(body + '\n')
    })
  })
  return new Promise((resolve) => server!.listen(socketPath, resolve))
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'smart-cursor-cu-'))
  socketPath = join(directory, 'control.sock')
  process.env.SMART_CURSOR_CU_SOCKET = socketPath
  received.length = 0
  reply = () => null
  resetCuHealthCache()
})

afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()))
  server = null
  delete process.env.SMART_CURSOR_CU_SOCKET
  resetCuHealthCache()
  await rm(directory, { recursive: true, force: true })
})

describe('cuHealth', () => {
  it('reports a trusted service as usable', async () => {
    await startServer()
    reply = () => JSON.stringify({
      jsonrpc: '2.0', id: 1,
      result: { service: 'cu-service', pid: 99, trusted: true, screenCapture: true, flags: '', methods: [] }
    })
    await expect(cuHealth({ fresh: true })).resolves.toMatchObject({ pid: 99, trusted: true })
  })

  it('treats an untrusted service as absent', async () => {
    // A service started through LaunchServices is healthy and useless: it cannot
    // read a single element. Reporting it as usable would break every step.
    await startServer()
    reply = () => JSON.stringify({
      jsonrpc: '2.0', id: 1,
      result: { service: 'cu-service', pid: 99, trusted: false, screenCapture: false, flags: '', methods: [] }
    })
    await expect(cuHealth({ fresh: true })).resolves.toBeNull()
  })

  it('reports nothing when the socket is missing', async () => {
    await expect(cuHealth({ fresh: true })).resolves.toBeNull()
  })

  it('never reaches a real service during a test run', async () => {
    // Without the redirect the client must refuse: a test that silently acted on
    // the developer's own applications would be worse than a failing test.
    delete process.env.SMART_CURSOR_CU_SOCKET
    resetCuHealthCache()
    await expect(cuHealth({ fresh: true })).resolves.toBeNull()
  })

  it('caches a healthy answer instead of paying a round trip per step', async () => {
    await startServer()
    reply = () => JSON.stringify({
      jsonrpc: '2.0', id: 1,
      result: { service: 'cu-service', pid: 99, trusted: true, screenCapture: true, flags: '', methods: [] }
    })
    await cuHealth({ fresh: true })
    await cuHealth()
    await cuHealth()
    expect(received.filter((entry) => entry.method === 'health')).toHaveLength(1)
  })
})

describe('cuResolve', () => {
  it('sends the query as named params, not as a coordinate', async () => {
    await startServer()
    reply = () => JSON.stringify({
      jsonrpc: '2.0', id: 1,
      result: { key: 'AXButton:Сохранить', role: 'AXButton', strategy: 'ariaLabel', confidence: 1, ambiguous: false, alternatives: 0 }
    })
    const found = await cuResolve(42, { text: 'Сохранить' })
    expect(found.key).toBe('AXButton:Сохранить')
    expect(received[0]).toEqual({
      method: 'resolve',
      params: { pid: 42, query: { text: 'Сохранить' } }
    })
  })

  it('carries the window filter only when one was named', async () => {
    await startServer()
    reply = () => JSON.stringify({ jsonrpc: '2.0', id: 1, result: { key: 'k', role: 'AXButton', strategy: 'structural', confidence: 1, ambiguous: false, alternatives: 0 } })
    await cuResolve(42, { text: 'Отмена' }, { window: 'Настройки' })
    expect(received[0]?.params).toMatchObject({ window: 'Настройки' })
  })
})

describe('cuAct', () => {
  it('returns the evidence the service collected', async () => {
    await startServer()
    reply = () => JSON.stringify({
      jsonrpc: '2.0', id: 1,
      result: {
        outcome: 'verified', verified: true, actionId: 'a1', target: 'AXButton:Сохранить',
        strategy: 'ariaLabel', confidence: 1, attempts: 1, durationMs: 42,
        dispatcher: 'AXSemantic', notifications: ['AXValueChanged'],
        cursorMoved: false, frontmostChanged: false, notes: []
      }
    })
    const result = await cuAct(42, { text: 'Сохранить' }, { kind: 'press' })
    expect(result).toMatchObject({ outcome: 'verified', dispatcher: 'AXSemantic', cursorMoved: false })
    expect(received[0]).toEqual({
      method: 'act',
      params: { pid: 42, query: { text: 'Сохранить' }, action: { kind: 'press' } }
    })
  })

  it('passes the typed text through to the field action', async () => {
    await startServer()
    reply = () => JSON.stringify({
      jsonrpc: '2.0', id: 1,
      result: {
        outcome: 'verified', verified: true, actionId: 'a2', target: 'AXTextField:Поиск',
        strategy: 'ariaLabel', confidence: 1, attempts: 1, durationMs: 60,
        dispatcher: 'SLEventPostToPid', notifications: [], cursorMoved: false,
        frontmostChanged: false, notes: []
      }
    })
    await cuAct(42, { text: 'Поиск' }, { kind: 'typeText', text: 'погода' })
    expect(received[0]?.params.action).toEqual({ kind: 'typeText', text: 'погода' })
  })

  it('surfaces a refusal as a typed error, not as a generic failure', async () => {
    await startServer()
    reply = () => JSON.stringify({
      jsonrpc: '2.0', id: 1,
      error: {
        code: CU_CODE.resolveFailed,
        message: 'ambiguous: 2 elements matched',
        data: { reason: 'ambiguous', candidates: ['AXButton:OK', 'AXButton:OK'] }
      }
    })
    const error = await cuAct(42, { text: 'OK' }, { kind: 'press' }).catch((value) => value)
    expect(error).toBeInstanceOf(CuRpcError)
    expect(error.code).toBe(CU_CODE.resolveFailed)
    // The candidates are what makes the refusal actionable for the caller.
    expect((error.data as { candidates: string[] }).candidates).toHaveLength(2)
  })
})

describe('transport', () => {
  it('gives up when the service closes without replying', async () => {
    await startServer((socket) => {
      socket.on('data', () => socket.end())
    })
    const error = await cuAct(42, { text: 'X' }, { kind: 'press' }).catch((value) => value)
    expect(error).toBeInstanceOf(CuUnavailable)
    expect((error as CuUnavailable).reason).toBe('transport')
  })

  it('does not start a call that was already cancelled', async () => {
    await startServer()
    const controller = new AbortController()
    controller.abort()
    const error = await cuAct(42, { text: 'X' }, { kind: 'press' }, { signal: controller.signal })
      .catch((value) => value)
    expect(error).toBeInstanceOf(CuUnavailable)
    expect(received).toHaveLength(0)
  })
})
