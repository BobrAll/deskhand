// Aggregate only known metadata. Never print raw events, scores, or parse errors.
import { readFile } from 'node:fs/promises'

const [tracePath, scoresPath] = process.argv.slice(2)
if (!tracePath) {
  console.error('Usage: node scripts/agent-trace-report.mjs TRACE.jsonl [SCORES.json]')
  process.exit(2)
}

const cases = JSON.parse(await readFile(new URL('../docs/agent-acceptance-cases.json', import.meta.url), 'utf8'))
const caseIds = new Set(cases.map(({ id }) => id))
const turns = new Map()
let malformedLines = 0
for (const line of (await readFile(tracePath, 'utf8')).split('\n').filter(Boolean)) {
  let event
  try { event = JSON.parse(line) } catch { malformedLines += 1; continue }
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
    if (!row || !turns.has(row.turn) || !caseIds.has(row.case) || scores.has(row.turn) ||
        !['cold', 'warm'].includes(row.start) ||
        !['success', 'wrongTarget', 'falseDone'].every((key) => typeof row[key] === 'boolean')) {
      throw new Error('Invalid, unknown or duplicate scored turn')
    }
    scores.set(row.turn, row)
  }
}

const statistics = (values) => {
  const sorted = values.filter((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0).sort((a, b) => a - b)
  if (!sorted.length) return { n: 0, median: null, p95: null }
  const mid = Math.floor(sorted.length / 2)
  return {
    n: sorted.length,
    median: sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2,
    p95: sorted[Math.ceil(sorted.length * 0.95) - 1]
  }
}

const runs = []
const coverage = Object.fromEntries(cases.map(({ id }) => [id, 0]))
const outcomes = Object.fromEntries([
  'answer', 'screen-confirmed', 'unconfirmed', 'interrupted', 'blocked', 'abandoned', 'cancelled', 'timeout', 'error', 'unrecorded'
].map((value) => [value, 0]))
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
  const model = events.filter((e) => e.event === 'model.round.end')
  runs.push({
    score, duration: end.durationMs, model,
    usage: events.filter((e) => e.event === 'model.usage'),
    firstAction: events.find((e) => e.event === 'agent.action.start')?.elapsedMs,
    ttft: events.filter((e) => e.event === 'model.firstChunk').map((e) => e.ttftMs),
    capture: events.filter((e) => e.event === 'screen.capture.end').map((e) => e.durationMs),
    verification: events.filter((e) => e.event === 'agent.verify.end').map((e) => e.durationMs)
  })
}

function summarize(group) {
  return {
    attempts: group.length,
    durationMs: statistics(group.map((r) => r.duration)),
    firstActionMs: statistics(group.map((r) => r.firstAction)),
    modelRounds: statistics(group.map((r) => r.model.length)),
    modelRoundMs: statistics(group.flatMap((r) => r.model.map((e) => e.durationMs))),
    reportedInputTokens: statistics(group.flatMap((r) => r.usage.map((e) => e.inputTokens))),
    reportedOutputTokens: statistics(group.flatMap((r) => r.usage.map((e) => e.outputTokens))),
    ttftMs: statistics(group.flatMap((r) => r.ttft)),
    captureMs: statistics(group.flatMap((r) => r.capture)),
    verificationMs: statistics(group.flatMap((r) => r.verification))
  }
}
const scored = runs.filter((r) => r.score)
const successful = scored.filter((r) => r.score.success)
const successfulCount = successful.length
console.log(JSON.stringify({
  malformedLines,
  unfinished: turns.size - runs.length,
  outcomes,
  all: summarize(runs),
  independentlyScored: scoresPath ? {
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
  } : null
}, null, 2))
