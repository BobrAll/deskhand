/**
 * The run request: what the app tells the agent before it starts.
 *
 * `sidecar.test.ts` covers the other direction — the events the real binary
 * wrote. This file covers the request the app writes, with the process replaced
 * by a fake pipe so the test can read the line it actually sent.
 */

import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ writes: [] as string[], diesAtStart: false }))

class FakeChild extends EventEmitter {
  exitCode: number | null = null
  readonly stdin = {
    write: (line: string) => {
      state.writes.push(line)
      const message = JSON.parse(line) as { id?: number; method?: string }
      if (typeof message.id !== 'number' || message.method !== 'run') return
      queueMicrotask(() => {
        this.stdout.emit('data', `${JSON.stringify({ id: message.id, result: { started: true } })}\n`)
      })
    }
  }
  readonly stdout = Object.assign(new EventEmitter(), { setEncoding: () => {} })
  readonly stderr = Object.assign(new EventEmitter(), { setEncoding: () => {} })

  constructor() {
    super()
    if (state.diesAtStart) {
      // Something a binary can really do before the handshake: a missing dylib,
      // a broken signature, a crash in its own startup.
      queueMicrotask(() => this.exitNow(1))
      return
    }
    queueMicrotask(() => {
      this.stdout.emit('data', `${JSON.stringify({ event: 'ready', params: { tools: 11 } })}\n`)
    })
  }

  private exitNow(code: number): void {
    this.exitCode = code
    this.emit('exit', code, null)
  }

  kill(): void {}
}

vi.mock('node:child_process', () => ({ spawn: () => new FakeChild() }))
vi.mock('node:fs', () => ({ existsSync: () => true }))
vi.mock('electron', () => ({ app: { getAppPath: () => '/tmp/app' } }))
vi.mock('../paths', () => ({ resourceCandidates: () => ['/tmp/deskhand-agent'] }))
vi.mock('./trace', () => ({ trace: () => {} }))

const RUN = {
  task: 'Нажми «Купить»',
  provider: {
    wire: 'openai' as const,
    baseUrl: 'https://example.test',
    model: 'm',
    apiKey: 'k',
    maxTokens: 1024,
    temperature: 0
  },
  maxSteps: 5,
  verifyActions: true,
  visualize: true,
  excludedApps: [] as string[]
}

beforeEach(() => {
  state.writes = []
  state.diesAtStart = false
})

describe('run request', () => {
  it('carries the excluded apps the settings configured', async () => {
    const { AgentSidecar } = await import('./sidecar')
    const sidecar = new AgentSidecar()

    await sidecar.run({
      ...RUN,
      excludedApps: ['com.apple.finder', 'com.1password.1password']
    })

    const request = state.writes
      .map(
        (line) =>
          JSON.parse(line) as {
            method?: string
            params?: { options?: { excluded_apps?: unknown } }
          }
      )
      .find((line) => line.method === 'run')

    expect(request?.params?.options?.excluded_apps).toEqual(['com.apple.finder', 'com.1password.1password'])
  })
})

describe('a process that dies before the handshake', () => {
  it('fails the start at once instead of waiting out the timeout', async () => {
    state.diesAtStart = true
    const { AgentSidecar } = await import('./sidecar')
    const sidecar = new AgentSidecar()

    const started = Date.now()
    await expect(sidecar.run(RUN)).rejects.toThrow('Агент остановился (1).')

    // Without the exit settling the ready promise this waits for the whole
    // ten-second handshake, and every request in the meantime is refused as
    // "a run is already in progress".
    expect(Date.now() - started).toBeLessThan(1_000)
  })

  it('lets the next run spawn a fresh process', async () => {
    state.diesAtStart = true
    const { AgentSidecar } = await import('./sidecar')
    const sidecar = new AgentSidecar()
    await expect(sidecar.run(RUN)).rejects.toThrow('Агент остановился (1).')

    state.diesAtStart = false
    const next = sidecar.run(RUN)
    await vi.waitFor(() => expect(state.writes.some((line) => JSON.parse(line).method === 'run')).toBe(true))
    await next
  })
})
