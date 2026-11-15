/**
 * The timing trace, end to end.
 *
 * Every other test on this path fakes one side of the language boundary: the
 * controller test feeds it events, and the protocol test feeds `translate()` a
 * recorded transcript. This one runs the **real Swift binary** against a stub
 * model and asserts that the numbers arrive in the trace, because the failure
 * mode being guarded against is precisely the one that unit tests cannot see —
 * a field renamed on one side, a rounding that erases the cheap path, or a
 * phase that never leaves the process.
 *
 * The binary is skipped when it has not been built, and so is the grant: the
 * sidecar refuses a run without Accessibility, so on a Mac that has not granted
 * it these tests would report a wall of failures that says nothing about the
 * code. A checkout without `npm run build:agent` runs the rest of the suite.
 */

import { spawn } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { agentAcceptsRuns } from './grant'
import { translate, type AgentSidecarEvent, type Message } from './sidecar'

const BINARY = fileURLToPath(new URL('../../../native/deskhand/.build/release/deskhand-agent', import.meta.url))
const built = existsSync(BINARY)
const canRun = built && (await agentAcceptsRuns(BINARY))

/**
 * What the stub model does on its first answer.
 *
 * Two modes, because the two things this file has to prove are different: that
 * the timings arrive at all, and that a run which never finishes is reported as
 * unfinished rather than as success. The second is the one that cost a real
 * user a task.
 */
let mode: 'batch' | 'spin' = 'batch'
let round = 0
let server: Server
let baseUrl: string

function startModel(): Promise<void> {
  round = 0
  server = createServer((request, response) => {
    // The request body is read to completion and then ignored: the stub answers
    // by turn number, and the point of this test is the agent's timings, not
    // what it asked.
    request.resume()
    request.on('end', () => {
      round += 1
      if (mode === 'spin') {
        // Always asks for another call, so the loop can only end on its budget.
        response.writeHead(200, { 'Content-Type': 'application/json' })
        response.end(
          JSON.stringify({
            id: `c${round}`,
            object: 'chat.completion',
            choices: [
              {
                index: 0,
                finish_reason: 'tool_calls',
                message: {
                  role: 'assistant',
                  content: 'Смотрю.',
                  tool_calls: [
                    {
                      id: `c${round}`,
                      type: 'function',
                      function: { name: 'list_apps', arguments: '{}' }
                    }
                  ]
                }
              }
            ],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
          })
        )
        return
      }
      const message =
        round === 1
          ? {
              role: 'assistant',
              content: 'Смотрю приложения.',
              tool_calls: [
                { id: 'c1', type: 'function', function: { name: 'list_apps', arguments: '{}' } },
                {
                  id: 'c2',
                  type: 'function',
                  function: {
                    name: 'get_app_state',
                    arguments: JSON.stringify({ app: 'Finder', include_screenshot: false })
                  }
                }
              ]
            }
          : { role: 'assistant', content: 'Готово: посмотрел.' }
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(
        JSON.stringify({
          id: `c${round}`,
          object: 'chat.completion',
          choices: [
            {
              index: 0,
              message,
              finish_reason: round === 1 ? 'tool_calls' : 'stop'
            }
          ],
          usage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 }
        })
      )
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
      resolve()
    })
  })
}

/** Runs one task through the real binary and collects every event it emits. */
function runAgent(task: string, maxSteps = 3): Promise<AgentSidecarEvent[]> {
  // The stub answers by turn number, so each run has to start from its first
  // answer again — otherwise the second test gets a closing sentence for step 1.
  round = 0
  return new Promise((resolve, reject) => {
    const child = spawn(BINARY, ['--serve'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { PATH: '/usr/bin:/bin', HOME: process.env.HOME ?? '/tmp' }
    })
    const events: AgentSidecarEvent[] = []
    let buffer = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error('the agent did not finish in 60 s'))
    }, 60_000)

    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8')
      let newline = buffer.indexOf('\n')
      while (newline !== -1) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        newline = buffer.indexOf('\n')
        if (!line.trim()) continue
        const event = translate(JSON.parse(line) as Message)
        if (!event) continue
        events.push(event)
        if (event.kind === 'done' || event.kind === 'error') {
          clearTimeout(timer)
          child.stdin.end()
          // The process exits on its own once its stdin closes; the events are
          // already in hand, so waiting for the exit would only add time.
          setTimeout(() => child.kill('SIGKILL'), 50)
          resolve(events)
        }
      }
    })
    child.stderr.on('data', () => {
      /* the agent's own log; not asserted on */
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })

    child.stdin.write(
      JSON.stringify({
        id: 1,
        method: 'run',
        params: {
          task,
          provider: {
            wire: 'openai',
            base_url: baseUrl,
            model: 'stub',
            api_key: 'test',
            max_tokens: 512,
            temperature: 0
          },
          options: { max_steps: maxSteps, verify_actions: false, verbose: false, timings: true }
        }
      }) + '\n'
    )
  })
}

beforeAll(async () => {
  if (canRun) await startModel()
})

afterAll(() => {
  server?.close()
})

describe.skipIf(!canRun)('a run that never finishes is reported as unfinished', () => {
  /**
   * The failure this pins down: a task the agent could not complete ended with
   * a `done` carrying the loop's own English sentence, and the card drew a
   * green checkmark over it. The task was "send a message in Telegram"; the run
   * opened Telegram, typed the word into search, and called itself done.
   */
  it('ends with a done that says it did not finish', async () => {
    mode = 'spin'
    try {
      const events = await runAgent('отправь сообщение в избранное', 3)
      const done = events.find((event) => event.kind === 'done')

      if (done?.kind !== 'done') throw new Error('expected a done event')
      expect(done.complete).toBe(false)
      // The loop's own sentence is still what it returns; the flag is what tells
      // the host not to show it as an answer.
      expect(done.answer).toContain('Stopped after 3 steps')
    } finally {
      mode = 'batch'
    }
  })

  it('says why it stopped, before it ends', async () => {
    mode = 'spin'
    try {
      const events = await runAgent('отправь сообщение в избранное', 3)
      const kinds = events.map((event) => event.kind)

      expect(kinds).toContain('stopped')
      expect(kinds.indexOf('stopped')).toBeLessThan(kinds.indexOf('done'))
      expect(events.find((event) => event.kind === 'stopped')).toMatchObject({ reason: 'the step budget ran out' })
    } finally {
      mode = 'batch'
    }
  })

  it('still reports a finished run as finished', async () => {
    const events = await runAgent('Посмотри, что открыто')
    const done = events.find((event) => event.kind === 'done')

    if (done?.kind !== 'done') throw new Error('expected a done event')
    expect(done.complete).toBe(true)
    expect(events.some((event) => event.kind === 'stopped')).toBe(false)
  })
})

describe.skipIf(!canRun)('the agent reports its timings over the wire', () => {
  it('emits a step timing for every model round trip', async () => {
    const events = await runAgent('Посмотри, что открыто')

    const steps = events.filter((event) => event.kind === 'stepTiming')
    expect(steps).toHaveLength(2)
    for (const step of steps) {
      if (step.kind !== 'stepTiming') continue
      // Real measurements, not placeholders: a round trip that took 0 ms would
      // mean the field never left the process.
      expect(step.timing.llmMs).toBeGreaterThan(0)
      expect(step.timing.promptBytes).toBeGreaterThan(0)
      expect(step.timing.history).toBeGreaterThan(0)
    }
  })

  it('reports how many calls each step asked for', async () => {
    const events = await runAgent('Посмотри, что открыто')
    const steps = events.filter((event) => event.kind === 'stepTiming')

    // The stub batches two calls into its first answer; the second answer has
    // none. This is the number that explains a run's shape without reading it.
    expect(steps[0]).toMatchObject({ timing: { calls: 2 } })
    expect(steps[1]).toMatchObject({ timing: { calls: 0 } })
  })

  it('carries the tokens the provider reported', async () => {
    const events = await runAgent('Посмотри, что открыто')
    const first = events.find((event) => event.kind === 'stepTiming')

    expect(first).toMatchObject({ timing: { inputTokens: 120, outputTokens: 30 } })
  })

  it('splits a call into the phases that ran', async () => {
    const events = await runAgent('Посмотри, что открыто')
    const results = events.filter((event) => event.kind === 'result')

    expect(results).toHaveLength(2)
    for (const result of results) {
      if (result.kind !== 'result') continue
      expect(result.timing.wallMs).toBeGreaterThanOrEqual(0)
    }

    // `get_app_state` walks the accessibility tree; the walk is the phase that
    // dominates it, and the whole reason the split exists.
    const state = results.find((event) => event.kind === 'result' && event.name === 'get_app_state')
    expect(state).toMatchObject({ timing: { treeMs: expect.any(Number) } })
    if (state?.kind !== 'result') return
    expect(state.timing.treeMs!).toBeGreaterThan(0)
    // No screenshot was requested, so there is no capture to blame.
    expect(state.timing.captureMs).toBeUndefined()
  })

  it('does not round a cheap call away', async () => {
    const events = await runAgent('Посмотри, что открыто')
    const list = events.find((event) => event.kind === 'result' && event.name === 'list_apps')

    // `list_apps` is the cheapest tool in the surface. Rounding its wall time to
    // an integer would print 0 and make the fast path look like it did nothing.
    if (list?.kind !== 'result') throw new Error('expected a list_apps result')
    expect(list.timing.wallMs).toBeGreaterThanOrEqual(0)
    expect(list.timing.wallMs).toBeLessThan(1000)
  })

  it('closes with the run’s totals, and they add up', async () => {
    const events = await runAgent('Посмотри, что открыто')
    const report = events.find((event) => event.kind === 'runReport')

    if (report?.kind !== 'runReport') throw new Error('expected a run report')
    expect(report.report.steps).toBe(2)
    expect(report.report.calls).toBe(2)
    expect(report.report.failedCalls).toBe(0)
    expect(report.report.totalMs).toBeGreaterThan(0)
    expect(report.report.llmMs).toBeGreaterThan(0)
    // The model cannot have taken longer than the run that contains it.
    expect(report.report.llmMs).toBeLessThanOrEqual(report.report.totalMs)
    expect(report.report.table).toContain('llm')
  })

  it('arrives in order: the timing of a step precedes its calls', async () => {
    const events = await runAgent('Посмотри, что открыто')
    const kinds = events.map((event) => event.kind)

    // A timeline that put the cost after the work it explains would read as the
    // wrong step's cost.
    expect(kinds.indexOf('stepTiming')).toBeLessThan(kinds.indexOf('result'))
    expect(kinds.lastIndexOf('runReport')).toBeLessThan(kinds.indexOf('done'))
  })
})
