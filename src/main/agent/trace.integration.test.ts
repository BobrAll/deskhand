/**
 * The whole chain: real binary → sidecar → controller → trace file → report.
 *
 * The unit tests on this path each fake one side of a boundary, which is right
 * for pinning behaviour but blind to the failure that actually costs an hour: a
 * value that is measured, emitted, translated, recorded — and then dropped by
 * the report because a name did not match. This test runs the thing end to end
 * and reads the file the app would have written.
 *
 * Skipped without a built binary, so a fresh checkout still runs the suite.
 */

import { createServer, type Server } from 'node:http'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { AgentEvent } from '@shared/types'

const BINARY = fileURLToPath(
  new URL('../../../native/deskhand/.build/release/deskhand-agent', import.meta.url)
)
const REPORT = fileURLToPath(new URL('../../../scripts/agent-trace-report.mjs', import.meta.url))
const built = existsSync(BINARY)

const state = vi.hoisted(() => ({
  enabled: true,
  traceDirectory: ''
}))

vi.mock('electron', () => ({
  systemPreferences: { isTrustedAccessibilityClient: () => true },
  app: {
    getPath: () => state.traceDirectory,
    getVersion: () => '0.0.0',
    // `agentBinary()` resolves the sidecar relative to the app path; mocking it
    // as missing would make the run fail before it started, which is the exact
    // failure this test exists to catch elsewhere.
    getAppPath: () => '/tmp'
  }
}))
vi.mock('../native/helper', () => ({
  helperBinary: () => '/bin/echo',
  watchForAbort: () => ({ stop: () => undefined })
}))
vi.mock('../settings/store', () => ({
  getSettings: () => ({
    agent: {
      enabled: true, maxSteps: 3, abortOnMouseMove: false,
      verifyResult: false, rememberedApprovals: []
    }
  }),
  patchSettings: () => undefined
}))
vi.mock('./sidecar', async (importOriginal) => {
  const real = await importOriginal<typeof import('./sidecar')>()
  return { ...real, agentBinary: () => BINARY }
})

const { createAgentController } = await import('./index')

let server: Server
let baseUrl: string
let round = 0

beforeAll(async () => {
  if (!built) return
  server = createServer((request, response) => {
    // The body is drained and ignored; the stub answers by turn number.
    request.resume()
    request.on('end', () => {
      round += 1
      const message = round === 1
        ? {
            role: 'assistant',
            content: 'Смотрю приложения.',
            tool_calls: [{
              id: 'c1', type: 'function', function: { name: 'list_apps', arguments: '{}' }
            }]
          }
        : { role: 'assistant', content: 'Готово: посмотрел.' }
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({
        id: `c${round}`,
        object: 'chat.completion',
        choices: [{ index: 0, message, finish_reason: round === 1 ? 'tool_calls' : 'stop' }],
        usage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 }
      }))
    })
  })
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
      resolve()
    })
  })
})

afterAll(() => {
  server?.close()
})

/** Runs one task through the real chain, with the trace pointed at `directory`. */
async function runAndReport(): Promise<{ events: AgentEvent[]; lines: Record<string, unknown>[] }> {
  const directory = mkdtempSync(join(tmpdir(), 'smart-cursor-e2e-'))
  state.traceDirectory = directory
  vi.stubEnv('SMART_CURSOR_AGENT_TRACE', '1')
  round = 0
  const events: AgentEvent[] = []
  const controller = createAgentController({
    emit: (event) => events.push(event),
    setPassthrough: () => undefined
  })

  try {
    await controller.run({
      prompt: 'Посмотри, что открыто',
      appName: 'Finder',
      windowTitle: null,
      provider: {
        wire: 'openai', baseUrl, model: 'stub',
        apiKey: 'test', maxTokens: 512, temperature: 0
      }
    })
    controller.dispose()

    const path = join(directory, 'agent-trace.jsonl')
    // The writer queues its appends; give it a moment rather than reading a
    // file that is still being written.
    await vi.waitFor(() => {
      expect(existsSync(path)).toBe(true)
      expect(readFileSync(path, 'utf8')).toContain('agent.report')
    }, { timeout: 10_000 }).catch((error) => {
      if (existsSync(path)) console.error('TRACE>>>', readFileSync(path, 'utf8'))
      throw error
    })
    const lines = readFileSync(path, 'utf8').trim().split('\n').map(
      (line) => JSON.parse(line) as Record<string, unknown>
    )
    return { events, lines }
  } finally {
    vi.unstubAllEnvs()
    rmSync(directory, { recursive: true, force: true })
  }
}

// These drive a real process and a real run loop: a few seconds each, not
// milliseconds. The default timeout is for pure functions.
vi.setConfig({ testTimeout: 60_000 })

describe.skipIf(!built)('a run’s timings reach the trace file', () => {
  it('records a step, its round trip, the call and the totals', async () => {
    const { lines } = await runAndReport()
    const kinds = lines.map((line) => line.event)

    expect(kinds).toContain('agent.step')
    expect(kinds).toContain('agent.llm')
    expect(kinds).toContain('agent.tool')
    expect(kinds).toContain('agent.call')
    expect(kinds).toContain('agent.report')
  })

  it('records real numbers, not placeholders', async () => {
    const { lines } = await runAndReport()

    const llm = lines.find((line) => line.event === 'agent.llm')!
    expect(llm.llmMs as number).toBeGreaterThan(0)
    expect(llm.promptBytes as number).toBeGreaterThan(0)
    expect(llm.history as number).toBeGreaterThan(0)
    expect(llm.inputTokens).toBe(120)
    expect(llm.outputTokens).toBe(30)

    const call = lines.find((line) => line.event === 'agent.call')!
    expect(call.tool).toBe('list_apps')
    expect(call.ok).toBe(true)
    expect(call.wallMs as number).toBeGreaterThanOrEqual(0)
  })

  it('records the run’s split between the model and the machine', async () => {
    const { lines } = await runAndReport()
    const report = lines.find((line) => line.event === 'agent.report')!

    expect(report.steps).toBe(2)
    expect(report.calls).toBe(1)
    expect(report.failedCalls).toBe(0)
    expect(report.totalMs as number).toBeGreaterThan(0)
    expect(report.llmMs as number).toBeGreaterThan(0)
    // The percentage is what tells a reader whether to batch calls or speed up
    // the tool layer, so it has to be there and be a real share.
    expect(report.modelShare as number).toBeGreaterThanOrEqual(0)
    expect(report.modelShare as number).toBeLessThanOrEqual(100)
  })

  it('does not record the prompt, the app or the screenshot', async () => {
    const { lines } = await runAndReport()
    const raw = JSON.stringify(lines)

    // The trace is meant to be safe to leave enabled. The task text is the
    // user's, and the accessibility tree is their screen.
    expect(raw).not.toContain('Посмотри, что открыто')
    expect(raw).not.toContain('Running applications')
  })

  it('produces a timeline the report script can read', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'smart-cursor-e2e-report-'))
    state.traceDirectory = directory
    vi.stubEnv('SMART_CURSOR_AGENT_TRACE', '1')
    round = 0
    const controller = createAgentController({
      emit: () => undefined,
      setPassthrough: () => undefined
    })
    try {
      await controller.run({
        prompt: 'Посмотри, что открыто',
        appName: 'Finder',
        windowTitle: null,
        provider: {
          wire: 'openai', baseUrl, model: 'stub',
          apiKey: 'test', maxTokens: 512, temperature: 0
        }
      })
      controller.dispose()
      const path = join(directory, 'agent-trace.jsonl')
      await vi.waitFor(() => {
        expect(existsSync(path) && readFileSync(path, 'utf8').includes('agent.report')).toBe(true)
      }, { timeout: 10_000 })

      const output = spawnSync('node', [REPORT, path, '--timeline'])
      // The report reads the file the app just wrote, so this is the whole
      // chain: measured in Swift, translated in TypeScript, recorded here,
      // rendered by a script that only knows the JSONL schema.
      expect(output).toContain('step 1/3')
      expect(output).toContain('model ')
      expect(output).toContain('list_apps')
      expect(output).toContain('tok')
      expect(output).toContain('timings (total')
    } finally {
      vi.unstubAllEnvs()
      rmSync(directory, { recursive: true, force: true })
    }
  })
})

/** Runs a command and returns its output. */
function spawnSync(command: string, args: string[]): string {
  return execFileSync(command, args, { encoding: 'utf8' })
}
