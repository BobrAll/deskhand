import { createServer, type Server, type Socket } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { CU_CODE, CuRpcError, CuUnavailable, cuAct, cuActByLabel, cuHealth, cuResolve, resetCuHealthCache } from './computerUse'

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

describe('cuActByLabel', () => {
  /**
   * The protocol's `text` field is a case-insensitive substring match over title,
   * aria-label and value joined together, so an ordinary label like «Назад»
   * matches the toolbar button *and* every mention of it in the page — eight
   * candidates in a real window, which the resolver refuses as ambiguous.
   *
   * These tests pin the order in which the shapes are tried, because the order is
   * the fix: exact fields first, the substring match last.
   */
  function answering(answer: (query: Record<string, unknown>) => string): void {
    reply = (request) => {
      const query = request.params.query as Record<string, unknown>
      return answer(query)
    }
  }

  function refusal(): string {
    return JSON.stringify({
      jsonrpc: '2.0', id: 1,
      error: { code: CU_CODE.resolveFailed, message: 'ambiguous', data: { candidates: ['a', 'b'] } }
    })
  }

  function performed(target: string): string {
    return JSON.stringify({
      jsonrpc: '2.0', id: 1,
      result: {
        outcome: 'verified', verified: true, actionId: 'a1', target,
        strategy: 'ariaLabel', confidence: 0.9, attempts: 1, durationMs: 40,
        dispatcher: 'AXSemantic', notifications: [], cursorMoved: false,
        frontmostChanged: false, notes: []
      }
    })
  }

  it('asks by exact title before the substring match', async () => {
    await startServer()
    const asked: string[] = []
    answering((query) => {
      asked.push(Object.keys(query).join('+'))
      return performed('AXButton:Назад')
    })

    await cuActByLabel(42, 'Назад', { kind: 'press' })

    expect(asked).toEqual(['title'])
  })

  it('moves on to the next exact field when the first matches nothing', async () => {
    await startServer()
    const asked: string[] = []
    answering((query) => {
      asked.push(Object.keys(query).join('+'))
      return query.title ? refusal() : performed('AXButton:Назад')
    })

    const result = await cuActByLabel(42, 'Назад', { kind: 'press' })

    expect(asked).toEqual(['title', 'ariaLabel'])
    expect(result.outcome).toBe('verified')
  })

  it('retries a refused *result*, not only a refused call', async () => {
    // The service answers "nothing matched" as a successful call carrying
    // `outcome: refused`, not as a JSON-RPC error. Treating only errors as
    // retryable made the cascade stop at the first shape and every label with an
    // empty `title` fall back to a click.
    await startServer()
    const asked: string[] = []
    answering((query) => {
      asked.push(Object.keys(query).join('+'))
      if (query.title) {
        return JSON.stringify({
          jsonrpc: '2.0', id: 1,
          result: {
            outcome: 'refused', verified: false, actionId: 'a0', target: 'none',
            strategy: 'none', confidence: 0, attempts: 0, durationMs: 5,
            dispatcher: 'AXSemantic', notifications: [], cursorMoved: false,
            frontmostChanged: false, notes: ['no element matched title=Назад']
          }
        })
      }
      return performed('AXButton:Назад')
    })

    const result = await cuActByLabel(42, 'Назад', { kind: 'press' })

    expect(asked).toEqual(['title', 'ariaLabel'])
    expect(result.outcome).toBe('verified')
  })

  it('narrows the substring match by role when the probe saw one', async () => {
    await startServer()
    const asked: Record<string, unknown>[] = []
    answering((query) => {
      asked.push(query)
      return query.text ? performed('AXButton:Назад') : refusal()
    })

    await cuActByLabel(42, 'Назад', { kind: 'press' }, { role: 'AXButton' })

    const loose = asked.find((query) => 'text' in query)
    expect(loose).toEqual({ text: 'Назад', role: 'AXButton' })
  })

  it('stops at the first shape that reached an element, even if it failed there', async () => {
    // `failed` means the control was found and does not take this action. Trying
    // another shape would aim at a different element with the same name, which is
    // how "нажми «Вперёд»" turns into pressing something else entirely.
    await startServer()
    const asked: string[] = []
    answering((query) => {
      asked.push(Object.keys(query).join('+'))
      return JSON.stringify({
        jsonrpc: '2.0', id: 1,
        result: {
          outcome: 'failed', verified: false, actionId: 'a1', target: 'AXButton:Назад',
          strategy: 'ariaLabel', confidence: 0.9, attempts: 1, durationMs: 30,
          dispatcher: 'AXSemantic', notifications: [], cursorMoved: false,
          frontmostChanged: false, notes: ['action call: unsupported']
        }
      })
    })

    const result = await cuActByLabel(42, 'Назад', { kind: 'press' })

    expect(asked).toEqual(['title'])
    expect(result.outcome).toBe('failed')
  })

  it('does not retry a transport failure, which may already have been delivered', async () => {
    // The same rule as a timeout: a connection that dies after the request was
    // written leaves the action in an unknown state, and re-asking would be a
    // second attempt at something that may have already happened.
    let asked = 0
    await startServer((socket) => {
      socket.on('data', () => {
        asked += 1
        socket.end()
      })
    })

    const error = await cuActByLabel(42, 'Назад', { kind: 'press' }).catch((value) => value)

    expect(error).toBeInstanceOf(CuUnavailable)
    expect(asked).toBe(1)
  })

  it('reports the last refusal when every shape declines', async () => {
    await startServer()
    answering(() => refusal())

    const error = await cuActByLabel(42, 'Назад', { kind: 'press' }).catch((value) => value)

    expect(error).toBeInstanceOf(CuRpcError)
    expect((error as CuRpcError).code).toBe(CU_CODE.resolveFailed)
  })
})
