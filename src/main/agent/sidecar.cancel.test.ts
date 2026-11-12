/**
 * Starting a run and stopping it are two messages on one pipe, and they do not
 * always arrive in the order the user pressed them in: the first run spends up
 * to ten seconds spawning before there is a process to cancel. These tests pin
 * down both orders — a stop before the run is written, and a stop after it was
 * sent but before its answer — and the run after the stopped one.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => {
  interface FakeChild {
    exitCode: number | null
    stdout: {
      setEncoding(): void
      on(event: string, handler: (chunk: string) => void): void
    }
    stderr: {
      setEncoding(): void
      on(event: string, handler: (chunk: string) => void): void
    }
    stdin: { write(line: string): boolean }
    once(event: string, handler: (...args: unknown[]) => void): void
    on(event: string, handler: (...args: unknown[]) => void): void
    kill(): boolean
    writes: string[]
    emitLine(message: Record<string, unknown>): void
    methods(): string[]
  }

  const children: FakeChild[] = []

  function make(): FakeChild {
    const writes: string[] = []
    let onData: ((chunk: string) => void) | null = null
    const child: FakeChild = {
      exitCode: null,
      writes,
      stdout: {
        setEncoding: () => undefined,
        on: (event, handler) => {
          if (event === 'data') onData = handler
        }
      },
      stderr: { setEncoding: () => undefined, on: () => undefined },
      stdin: {
        write: (line) => {
          writes.push(line)
          return true
        }
      },
      once: () => undefined,
      on: () => undefined,
      kill: () => true,
      emitLine: (message) => {
        onData?.(`${JSON.stringify(message)}\n`)
      },
      methods: () => writes.map((line) => (JSON.parse(line) as { method?: string }).method ?? '')
    }
    children.push(child)
    return child
  }

  return { children, make }
})

vi.mock('node:child_process', () => ({ spawn: () => state.make() }))
vi.mock('node:fs', () => ({ existsSync: () => true }))
vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => '/app' }
}))

import { AgentSidecar, type AgentRunOptions } from './sidecar'

const RUN: AgentRunOptions = {
  task: 'open the page',
  traceRunId: 'trace-1',
  provider: {
    wire: 'openai',
    baseUrl: 'https://example.test',
    model: 'model',
    apiKey: 'key',
    maxTokens: 1024,
    temperature: 0
  },
  maxSteps: 3,
  verifyActions: false,
  visualize: false,
  excludedApps: []
}

function latest(): (typeof state.children)[number] {
  const child = state.children.at(-1)
  if (!child) throw new Error('the sidecar did not spawn a process')
  return child
}

function ready(child: (typeof state.children)[number]): void {
  child.emitLine({ event: 'ready', params: { tools: 11 } })
}

function requestID(child: (typeof state.children)[number], method: string): number {
  for (const line of child.writes) {
    const message = JSON.parse(line) as { id?: number; method?: string }
    if (message.method === method && typeof message.id === 'number') return message.id
  }
  throw new Error(`no ${method} request was written`)
}

function accepted(child: (typeof state.children)[number]): void {
  child.emitLine({ id: requestID(child, 'run'), result: { started: true } })
}

beforeEach(() => {
  state.children.length = 0
})

describe('a stop that races the start of a run', () => {
  it('does not send a run stopped while the process was starting', async () => {
    // The run is waiting for `ready`; there is no run to cancel yet, so a
    // cancel written now is a no-op. Sending the run afterwards would start an
    // agent with no card, no events and no Escape.
    const sidecar = new AgentSidecar()
    const pending = sidecar.run(RUN)
    const child = latest()

    sidecar.cancel()
    ready(child)
    await pending

    expect(child.methods()).toEqual(['cancel'])
  })

  it('repeats the stop after the run it raced was accepted', async () => {
    // The run is already written, so the first cancel follows it on the pipe
    // and lands. The repeated one is for the order where the process saw the
    // cancel first, while it had no active run.
    const sidecar = new AgentSidecar()
    const pending = sidecar.run(RUN)
    const child = latest()
    ready(child)
    await vi.waitFor(() => expect(child.methods()).toContain('run'))

    sidecar.cancel()
    const writesAtStop = child.writes.length
    accepted(child)
    await pending

    expect(child.methods().slice(writesAtStop)).toEqual(['cancel'])
    expect(child.methods()).toEqual(['run', 'cancel', 'cancel'])
  })

  it('lets the next run start normally after a stop during startup', async () => {
    const sidecar = new AgentSidecar()
    const stopped = sidecar.run(RUN)
    const child = latest()

    sidecar.cancel()
    ready(child)
    await stopped
    expect(child.methods()).toEqual(['cancel'])

    const next = sidecar.run(RUN)
    await vi.waitFor(() => expect(child.methods()).toContain('run'))
    accepted(child)
    await next

    // The stop belonged to the first run and must not cancel the next one.
    expect(child.methods()).toEqual(['cancel', 'run'])
  })

  it('does not carry a stop from before the run into the next one', async () => {
    const sidecar = new AgentSidecar()
    sidecar.cancel()
    expect(state.children).toHaveLength(0)

    const pending = sidecar.run(RUN)
    const child = latest()
    ready(child)
    await vi.waitFor(() => expect(child.methods()).toContain('run'))
    accepted(child)
    await pending

    expect(child.methods()).toEqual(['run'])
  })

  it('sends one run and no cancel when nothing asked to stop', async () => {
    const sidecar = new AgentSidecar()
    const pending = sidecar.run(RUN)
    const child = latest()
    ready(child)
    await vi.waitFor(() => expect(child.methods()).toContain('run'))
    accepted(child)
    await pending

    expect(child.methods()).toEqual(['run'])
  })
})
