/**
 * The run request: what the app tells the agent before it starts.
 *
 * `sidecar.test.ts` covers the other direction — the events the real binary
 * wrote. This file covers the request the app writes, with the process replaced
 * by a fake pipe so the test can read the line it actually sent.
 */

import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ writes: [] as string[] }))

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
    queueMicrotask(() => {
      this.stdout.emit('data', `${JSON.stringify({ event: 'ready', params: { tools: 11 } })}\n`)
    })
  }

  kill(): void {}
}

vi.mock('node:child_process', () => ({ spawn: () => new FakeChild() }))
vi.mock('node:fs', () => ({ existsSync: () => true }))
vi.mock('electron', () => ({ app: { getAppPath: () => '/tmp/app' } }))
vi.mock('../paths', () => ({ resourceCandidates: () => ['/tmp/deskhand-agent'] }))
vi.mock('./trace', () => ({ trace: () => {} }))

describe('run request', () => {
  it('carries the excluded apps the settings configured', async () => {
    const { AgentSidecar } = await import('./sidecar')
    const sidecar = new AgentSidecar()

    await sidecar.run({
      task: 'Нажми «Купить»',
      provider: {
        wire: 'openai',
        baseUrl: 'https://example.test',
        model: 'm',
        apiKey: 'k',
        maxTokens: 1024,
        temperature: 0
      },
      maxSteps: 5,
      verifyActions: true,
      visualize: true,
      excludedApps: ['com.apple.finder', 'com.1password.1password']
    })

    const request = state.writes
      .map((line) => JSON.parse(line) as {
        method?: string
        params?: { options?: { excluded_apps?: unknown } }
      })
      .find((line) => line.method === 'run')

    expect(request?.params?.options?.excluded_apps).toEqual([
      'com.apple.finder',
      'com.1password.1password'
    ])
  })
})
