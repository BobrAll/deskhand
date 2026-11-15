// Aggregate only known metadata. Never print raw events, scores, or parse errors.
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const argv = process.argv.slice(2)
// `--timeline` prints one run per line group instead of the aggregate: the
// aggregate answers "is it getting better", the timeline answers "what happened
// in this run", and those are different questions asked at different times.
const timeline = argv.includes('--timeline')
const [givenPath, scoresPath] = argv.filter((arg) => !arg.startsWith('--'))

/**
 * Where the app writes its trace, when no path is given.
 *
 * The common case is "what just happened", and requiring the user to find the
 * log directory first makes the tool useless at exactly the moment it is needed.
 */
const DEFAULT_TRACE = join(homedir(), 'Library', 'Application Support', 'deskhand', 'agent-trace.jsonl')
const tracePath = givenPath ?? DEFAULT_TRACE
if (!givenPath && !existsSync(DEFAULT_TRACE)) {
  console.error(`No trace at ${DEFAULT_TRACE}`)
  console.error('Usage: node scripts/agent-trace-report.mjs [TRACE.jsonl] [SCORES.json] [--timeline]')
  process.exit(2)
}

const cases = JSON.parse(await readFile(new URL('../docs/agent-acceptance-cases.json', import.meta.url), 'utf8'))
const caseIds = new Set(cases.map(({ id }) => id))
const turns = new Map()
let malformedLines = 0
for (const line of (await readFile(tracePath, 'utf8')).split('\n').filter(Boolean)) {
  let event
  try {
    event = JSON.parse(line)
  } catch {
    malformedLines += 1
    continue
  }
  if (!event || typeof event.turn !== 'string' || typeof event.event !== 'string') continue
  const events = turns.get(event.turn) ?? []
  events.push(event)
  turns.set(event.turn, events)
}

const scores = new Map()
if (scoresPath) {
  const input = JSON.parse(await readFile(scoresPath, 'utf8'))
  if (!Array.isArray(input)) throw new Error('Scores must be an array')
  for (const row of input) {
    if (
      !row ||
      !turns.has(row.turn) ||
      !caseIds.has(row.case) ||
      scores.has(row.turn) ||
      !['cold', 'warm'].includes(row.start) ||
      !['success', 'wrongTarget', 'falseDone'].every((key) => typeof row[key] === 'boolean')
    ) {
      throw new Error('Invalid, unknown or duplicate scored turn')
    }
    scores.set(row.turn, row)
  }
}

const statistics = (values) => {
  const sorted = values.filter((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0).sort((a, b) => a - b)
  if (!sorted.length) return { n: 0, median: null, p95: null }
  const mid = Math.floor(sorted.length / 2)
  const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
  // One decimal: the inputs are already tenths of a millisecond, and a median
  // printed as 252.39999999999998 is a number nobody can read.
  const round = (n) => Math.round(n * 10) / 10
  return { n: sorted.length, median: round(median), p95: round(sorted[Math.ceil(sorted.length * 0.95) - 1]) }
}

const runs = []
const coverage = Object.fromEntries(cases.map(({ id }) => [id, 0]))
// The outcomes the turn recorder can write. `screen-confirmed` and `unconfirmed`
// were the old runner's verdicts on its own plan; the agent now reports what it
// did and the trace records that instead, so a run that acted ends as
// `agent-report` and one that only spoke ends as `agent-silent`.
const outcomes = Object.fromEntries(
  [
    'answer',
    'agent-report',
    'agent-silent',
    'interrupted',
    'blocked',
    'abandoned',
    'cancelled',
    'timeout',
    'error',
    'unrecorded'
  ].map((value) => [value, 0])
)
for (const [id, events] of turns) {
  const end = events.find((e) => e.event === 'turn.end')
  if (!end) {
    if (scores.has(id)) throw new Error('A scored turn is missing its end event')
    continue
  }
  const score = scores.get(id)
  if (score) coverage[score.case] += 1
  const outcome = events.find((e) => e.event === 'turn.outcome')?.outcome
  outcomes[Object.hasOwn(outcomes, outcome) ? outcome : 'unrecorded'] += 1
  // The agent reports its own model round trips (`agent.llm`); a writer turn
  // reports its streamed rounds (`model.round.end`). Either is a round trip, so
  // the count falls back rather than reading as "no model calls" on an agent run.
  const agentSteps = events.filter((e) => e.event === 'agent.llm')
  const writerRounds = events.filter((e) => e.event === 'model.round.end')
  const model = agentSteps.length ? agentSteps : writerRounds
  runs.push({
    score,
    duration: end.durationMs,
    model,
    usage: events.filter((e) => e.event === 'model.usage'),
    firstAction: events.find((e) => e.event === 'agent.call')?.elapsedMs,
    ttft: events.filter((e) => e.event === 'model.firstChunk').map((e) => e.ttftMs),
    // The writer's own screenshot capture, distinct from the capture phase
    // inside an agent tool call.
    screenshot: events.filter((e) => e.event === 'screen.capture.end').map((e) => e.durationMs),
    // How many calls the agent made and how many of them failed. A run that took
    // five calls to press one button is the interesting number here, not the
    // duration of a verification round trip that no longer exists.
    calls: events.filter((e) => e.event === 'agent.call'),
    approvals: events.filter((e) => e.event === 'agent.approval'),
    // The agent's own measurements: per-step round trips and the run's totals.
    steps: agentSteps,
    report: events.find((e) => e.event === 'agent.report')
  })
}

function summarize(group) {
  return {
    attempts: group.length,
    durationMs: statistics(group.map((r) => r.duration)),
    firstActionMs: statistics(group.map((r) => r.firstAction)),
    modelRounds: statistics(group.map((r) => r.model.length)),
    modelRoundMs: statistics(group.flatMap((r) => r.model.map((e) => e.durationMs ?? e.llmMs))),
    reportedInputTokens: statistics(
      group.flatMap((r) => (r.usage.length ? r.usage.map((e) => e.inputTokens) : r.steps.map((e) => e.inputTokens)))
    ),
    reportedOutputTokens: statistics(
      group.flatMap((r) => (r.usage.length ? r.usage.map((e) => e.outputTokens) : r.steps.map((e) => e.outputTokens)))
    ),
    ttftMs: statistics(group.flatMap((r) => r.ttft)),
    screenshotMs: statistics(group.flatMap((r) => r.screenshot)),
    callsPerRun: statistics(group.map((r) => r.calls.length)),
    failedCalls: group.flatMap((r) => r.calls).filter((e) => e.ok === false).length,
    questionsAsked: group.flatMap((r) => r.approvals).filter((e) => e.outcome === 'asked').length,
    // The split that decides what to fix: waiting on the provider versus
    // working on the machine. `modelShare` is the share of a run spent on the
    // model — when it is high, batch more calls per answer; when it is low, the
    // time is in the accessibility layer or the capture and no prompt helps.
    modelShare: (() => {
      const total = group.reduce((sum, r) => sum + (r.report?.totalMs ?? 0), 0)
      const model = group.reduce((sum, r) => sum + (r.report?.llmMs ?? 0), 0)
      return total > 0 ? Math.round((model / total) * 100) : null
    })(),
    // Which phase of a tool call costs the time. A run dominated by `tree` is
    // fixed in the accessibility layer; one dominated by `capture` is fixed in
    // ScreenCaptureKit; neither is fixed by a prompt change.
    treeMs: statistics(group.flatMap((r) => r.calls.map((e) => e.treeMs))),
    captureMs: statistics(group.flatMap((r) => r.calls.map((e) => e.captureMs))),
    encodeMs: statistics(group.flatMap((r) => r.calls.map((e) => e.encodeMs))),
    /** Steps the agent actually ran, versus the budget it was given. */
    agentSteps: statistics(group.map((r) => r.steps.length))
  }
}

/**
 * A duration a person can read at a glance.
 *
 * Milliseconds below a second, seconds above it: a click that took 31 ms and a
 * capture that took 518 ms are both "fast" and "slow" respectively, and
 * printing `0.0s` for the first one makes the cheap path look like it did not
 * happen at all.
 */
const secs = (ms) => {
  if (typeof ms !== 'number') return '—'
  if (ms < 1) return '<1ms'
  if (ms < 1000) return Math.round(ms) + 'ms'
  return (ms / 1000).toFixed(2) + 's'
}

/**
 * One run, top to bottom: the step it belonged to, when it happened, and what
 * it cost.
 *
 * Deliberately prints only the fields the recorder already decided are safe —
 * no prompts, no typed text, no window titles, no screenshots. A timeline that
 * leaked the user's screen would be a timeline nobody could leave enabled.
 */
function printTimeline(id, events) {
  const start = events.find((e) => e.event === 'turn.start')
  if (!start) return
  const outcome = events.find((e) => e.event === 'turn.outcome')?.outcome ?? 'unrecorded'
  const report = events.find((e) => e.event === 'agent.report')
  const route = events.find((e) => e.event === 'tool.route')
  const head = [
    id.slice(0, 8),
    outcome.padEnd(13),
    secs(events.find((e) => e.event === 'turn.end')?.durationMs),
    route?.backend ? 'via ' + route.backend : 'via writer'
  ]
  if (report) {
    head.push(
      report.steps + ' steps',
      report.calls + ' calls' + (report.failedCalls ? ' (' + report.failedCalls + ' failed)' : ''),
      'model ' + secs(report.llmMs),
      'tools ' + secs(report.toolMs)
    )
  }
  console.log(head.join('  '))

  for (const event of events) {
    const at = secs(event.elapsedMs).padStart(6)
    if (event.event === 'agent.step') {
      console.log(`  ${at}  step ${event.step}/${event.total}`)
    } else if (event.event === 'agent.llm') {
      const tok = event.inputTokens === undefined ? '' : `  ${event.inputTokens}→${event.outputTokens ?? '?'} tok`
      // The history size is what makes the duration interpretable: a slow round
      // trip on two messages is the network, on twenty it is the prompt.
      console.log(
        `  ${at}    model ${secs(event.llmMs)}  ${event.history} msg  ${event.promptBytes} B${tok}` +
          (event.calls ? `  ${event.calls} call${event.calls === 1 ? '' : 's'}` : '')
      )
    } else if (event.event === 'agent.call') {
      const phases = [
        event.treeMs !== undefined && 'tree ' + secs(event.treeMs),
        event.captureMs !== undefined && 'capture ' + secs(event.captureMs),
        event.encodeMs !== undefined && 'encode ' + secs(event.encodeMs),
        event.imageBytes !== undefined && (event.imageBytes / 1024).toFixed(0) + 'kB'
      ]
        .filter(Boolean)
        .join(', ')
      console.log(
        `  ${at}    ${event.ok ? 'ok  ' : 'FAIL'} ${event.tool} ${secs(event.wallMs)}` + (phases ? `  (${phases})` : '')
      )
    } else if (event.event === 'agent.approval') {
      console.log(`  ${at}    ask  ${event.tool ?? ''} → ${event.outcome}`)
    } else if (event.event === 'agent.abort') {
      console.log(`  ${at}    stop ${event.reason ?? ''}`)
    }
  }
  const table = events.find((e) => e.event === 'agent.timings')?.table
  if (table) {
    for (const line of String(table).split(/\r?\n/)) console.log('    ' + line)
  }
  console.log('')
}

if (timeline) {
  for (const [id, events] of turns) printTimeline(id, events)
  process.exit(0)
}
const scored = runs.filter((r) => r.score)
const successful = scored.filter((r) => r.score.success)
const successfulCount = successful.length
console.log(
  JSON.stringify(
    {
      malformedLines,
      unfinished: turns.size - runs.length,
      outcomes,
      all: summarize(runs),
      independentlyScored: scoresPath
        ? {
            coverage,
            hasFiveRunsPerCase: Object.values(coverage).every((n) => n >= 5),
            successes: successfulCount,
            successRate: scored.length ? successfulCount / scored.length : null,
            wrongTarget: scored.filter((r) => r.score.wrongTarget).length,
            falseDone: scored.filter((r) => r.score.falseDone).length,
            all: summarize(scored),
            successful: summarize(successful),
            cold: summarize(scored.filter((r) => r.score.start === 'cold')),
            warm: summarize(scored.filter((r) => r.score.start === 'warm'))
          }
        : null
    },
    null,
    2
  )
)
