/**
 * The timeline the trace report prints.
 *
 * The report is the only place a slow run can be understood after the fact, so
 * what it prints is worth pinning down: the aggregate answers "is it getting
 * better", the timeline answers "what happened in this run". These tests run the
 * real script against a synthetic trace, because the thing under test is the
 * output a person reads, not a function they call.
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const SCRIPT = fileURLToPath(new URL('../../../scripts/agent-trace-report.mjs', import.meta.url))
const TURN = 'a1b2c3d4-0000-0000-0000-000000000001'

/** One two-step agent run: a tree walk, a click behind a question, then the answer. */
const EVENTS: Record<string, unknown>[] = [
  { event: 'turn.start', elapsedMs: 0, schema: 2 },
  { event: 'tool.route', elapsedMs: 3, backend: 'agent', reason: 'action-request' },
  { event: 'agent.start', elapsedMs: 4, maxSteps: 8, verify: true, hasApp: true },
  { event: 'agent.step', elapsedMs: 120, step: 1, total: 8 },
  {
    event: 'agent.llm',
    elapsedMs: 1980,
    step: 1,
    llmMs: 1860.4,
    promptBytes: 4821,
    history: 2,
    calls: 2,
    inputTokens: 1204,
    outputTokens: 62
  },
  { event: 'agent.tool', elapsedMs: 1990, step: 1, tool: 'get_app_state' },
  {
    event: 'agent.call',
    elapsedMs: 2510,
    step: 1,
    tool: 'get_app_state',
    ok: true,
    wallMs: 518.1,
    treeMs: 476.4,
    captureMs: 12.1,
    encodeMs: 4.6,
    imageBytes: 151812
  },
  { event: 'agent.tool', elapsedMs: 2520, step: 1, tool: 'click' },
  { event: 'agent.approval', elapsedMs: 2600, outcome: 'asked', tool: 'click' },
  { event: 'agent.call', elapsedMs: 7400, step: 1, tool: 'click', ok: true, wallMs: 31.2, treeMs: 28.4 },
  { event: 'agent.step', elapsedMs: 7420, step: 2, total: 8 },
  {
    event: 'agent.llm',
    elapsedMs: 9200,
    step: 2,
    llmMs: 1770.8,
    promptBytes: 21044,
    history: 5,
    calls: 0,
    inputTokens: 5210,
    outputTokens: 48
  },
  {
    event: 'agent.report',
    elapsedMs: 9210,
    steps: 2,
    calls: 2,
    failedCalls: 0,
    totalMs: 9188.2,
    llmMs: 3631.2,
    toolMs: 549.3,
    modelShare: 40
  },
  { event: 'turn.outcome', elapsedMs: 9213, outcome: 'agent-report', reason: 'agent-answer' },
  { event: 'turn.end', elapsedMs: 9215, durationMs: 9215 }
]

let directory: string
let tracePath: string

function report(...flags: string[]): string {
  return execFileSync('node', [SCRIPT, tracePath, ...flags], { encoding: 'utf8' })
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'deskhand-report-'))
  tracePath = join(directory, 'agent-trace.jsonl')
  writeFileSync(
    tracePath,
    EVENTS.map((event) =>
      JSON.stringify({
        time: new Date(Date.UTC(2026, 10, 8, 19, 0, 0) + (event.elapsedMs as number)).toISOString(),
        turn: TURN,
        ...event
      })
    ).join('\n') + '\n'
  )
})

afterEach(() => {
  rmSync(directory, { recursive: true, force: true })
})

describe('the timeline', () => {
  it('prints one line per step and one per call, in order', () => {
    const lines = report('--timeline').split('\n').filter(Boolean)

    expect(lines[0]).toContain('agent-report')
    expect(lines[0]).toContain('2 steps')
    expect(lines[0]).toContain('2 calls')
    expect(lines[0]).toContain('model 3.63s')
    expect(lines[0]).toContain('tools 549ms')

    const steps = lines.filter((line) => line.includes('step '))
    expect(steps.map((line) => line.trim().split('  ')[1])).toEqual(['step 1/8', 'step 2/8'])
  })

  it('shows what the round trip cost, and what it was asked with', () => {
    const line = report('--timeline')
      .split('\n')
      .find((entry) => entry.includes('model 1.86s'))

    expect(line).toBeDefined()
    expect(line).toContain('2 msg')
    expect(line).toContain('4821 B')
    expect(line).toContain('1204→62 tok')
    expect(line).toContain('2 calls')
  })

  it('splits a call into the phases that ran, and leaves the others out', () => {
    const lines = report('--timeline').split('\n')

    // The 518 ms call is diagnosable only because the walk is separated from
    // the capture: without the split it looks like a slow model.
    const slow = lines.find((line) => line.includes('get_app_state'))
    expect(slow).toContain('518ms')
    expect(slow).toContain('tree 476ms')
    expect(slow).toContain('capture 12ms')
    expect(slow).toContain('148kB')

    // The click reported no capture and no encode; it must not claim it did.
    const click = lines.find((line) => line.includes('click 31ms'))
    expect(click).toContain('tree 28ms')
    expect(click).not.toContain('capture')
    expect(click).not.toContain('encode')
  })

  it('marks a failed call as failed', () => {
    writeFileSync(
      tracePath,
      [
        JSON.stringify({ time: '2026-11-08T19:00:00.000Z', turn: TURN, event: 'turn.start', elapsedMs: 0 }),
        JSON.stringify({
          time: '2026-11-08T19:00:01.000Z',
          turn: TURN,
          event: 'agent.call',
          elapsedMs: 1000,
          step: 1,
          tool: 'click',
          ok: false,
          wallMs: 12.5
        }),
        JSON.stringify({
          time: '2026-11-08T19:00:02.000Z',
          turn: TURN,
          event: 'turn.end',
          elapsedMs: 2000,
          durationMs: 2000
        })
      ].join('\n') + '\n'
    )

    expect(report('--timeline')).toContain('FAIL click 13ms')
  })

  it('does not print a prompt, a window title or a screenshot', () => {
    const output = report('--timeline')

    // The trace never records these, so the report must not invent them.
    expect(output).not.toMatch(/Купить|Магазин|Safari/)
  })
})

describe('the aggregate', () => {
  const aggregate = () => JSON.parse(report())

  it('counts the agent’s steps as model round trips', () => {
    const all = aggregate().all

    // Two `agent.llm` events, so two rounds — not zero, which is what a report
    // that only knew the writer's events would say about an agent run.
    expect(all.modelRounds).toEqual({ n: 1, median: 2, p95: 2 })
    expect(all.modelRoundMs.n).toBe(2)
  })

  it('reports where the time went, per phase', () => {
    const all = aggregate().all

    expect(all.modelShare).toBe(40)
    expect(all.treeMs).toEqual({ n: 2, median: 252.4, p95: 476.4 })
    expect(all.captureMs).toEqual({ n: 1, median: 12.1, p95: 12.1 })
    expect(all.encodeMs).toEqual({ n: 1, median: 4.6, p95: 4.6 })
  })

  it('reads the tokens the agent reported', () => {
    const all = aggregate().all

    expect(all.reportedInputTokens).toEqual({ n: 2, median: 3207, p95: 5210 })
    expect(all.reportedOutputTokens).toEqual({ n: 2, median: 55, p95: 62 })
  })

  it('counts the questions the run asked', () => {
    expect(aggregate().all.questionsAsked).toBe(1)
  })

  it('counts a failed call without failing the run', () => {
    // A call that errored is data, not a verdict: the agent may recover, and a
    // report that treated one bad click as a broken run would be useless.
    writeFileSync(
      tracePath,
      [
        JSON.stringify({ time: '2026-11-08T19:00:00.000Z', turn: TURN, event: 'turn.start', elapsedMs: 0 }),
        JSON.stringify({
          time: '2026-11-08T19:00:01.000Z',
          turn: TURN,
          event: 'agent.call',
          elapsedMs: 1000,
          step: 1,
          tool: 'click',
          ok: false,
          wallMs: 12.5
        }),
        JSON.stringify({
          time: '2026-11-08T19:00:02.000Z',
          turn: TURN,
          event: 'turn.outcome',
          elapsedMs: 2000,
          outcome: 'agent-report'
        }),
        JSON.stringify({
          time: '2026-11-08T19:00:02.100Z',
          turn: TURN,
          event: 'turn.end',
          elapsedMs: 2100,
          durationMs: 2100
        })
      ].join('\n') + '\n'
    )

    const result = aggregate()
    expect(result.all.failedCalls).toBe(1)
    expect(result.unfinished).toBe(0)
    expect(result.outcomes['agent-report']).toBe(1)
  })
})
