import { AsyncLocalStorage } from 'node:async_hooks'
import { appendFile, rename, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { app } from 'electron'

type Fields = Record<string, string | number | boolean | null>
interface Turn {
  id: string
  path: string
  started: number
  nextSpan: number
}

const turn = new AsyncLocalStorage<Turn>()
/**
 * The turns that are still open.
 *
 * `AsyncLocalStorage` binds a context to a callback, and those callbacks outlive
 * the turn that registered them. The agent sidecar is spawned once and its
 * stdout listener is attached during the first action request, so every event
 * the long-lived process emitted afterwards was filed under the turn that
 * happened to start it: one turn ended up holding three more minutes of another
 * turn's work, and a single run looked like it repeated every step twice.
 *
 * Keeping the open turns is what lets a stale context be recognised as stale
 * without breaking turns that really do overlap.
 */
const open = new Set<Turn>()
const MAX_BYTES = 2 * 1024 * 1024
let writes = Promise.resolve()
let warned = false

/**
 * The turn an event belongs to, or nothing.
 *
 * A live context wins, because overlapping turns each have their own. A context
 * whose turn has already closed is ignored — it came from a callback that
 * outlived it — and the single turn still open is the honest answer. When
 * several are open and none matches, guessing would be worse than dropping the
 * event.
 */
function currentTurn(): Turn | null {
  const ambient = turn.getStore()
  if (ambient && open.has(ambient)) return ambient
  if (open.size === 1) return open.values().next().value ?? null
  return null
}

/**
 * Waits for the queued writes to reach the disk.
 *
 * The writes are chained so a burst of events does not interleave mid-line, but
 * they are fire-and-forget: a process that quits on the last event of a run
 * would exit with the line still in the queue, and the run would look like it
 * ended one event early. Called on quit, not per event.
 */
export function flushTrace(): Promise<void> {
  return writes
}

export function trace(event: string, fields: Fields = {}): void {
  const current = currentTurn()
  if (!current) return
  const { id, path, started } = current
  const line = JSON.stringify({
    time: new Date().toISOString(),
    turn: id,
    elapsedMs: Math.round(performance.now() - started),
    event,
    ...fields
  }) + '\n'
  writes = writes.then(async () => {
    const size = (await stat(path).catch(() => null))?.size ?? 0
    if (size + Buffer.byteLength(line) > MAX_BYTES) await rename(path, path + '.previous')
    await appendFile(path, line, { mode: 0o600 })
  }).catch(() => {
    if (!warned) console.warn('[agent trace] Unable to write the local trace')
    warned = true
  })
}

export function traceEnd(event: string, fields: Fields = {}): () => void {
  const current = currentTurn()
  if (!current) return () => undefined
  const span = ++current.nextSpan
  const start = performance.now()
  trace(event + '.start', { ...fields, span })
  return () => trace(event + '.end', { ...fields, span, durationMs: Math.round(performance.now() - start) })
}

export async function timed<T>(event: string, work: () => Promise<T>, fields?: Fields): Promise<T> {
  const end = traceEnd(event, fields)
  try {
    return await work()
  } finally {
    end()
  }
}

/** Record counts only, when the provider supplies them. */
export function traceModelUsage(input: unknown, output: unknown): void {
  const fields: Fields = {}
  if (typeof input === 'number' && Number.isSafeInteger(input) && input >= 0) fields.inputTokens = input
  if (typeof output === 'number' && Number.isSafeInteger(output) && output >= 0) fields.outputTokens = output
  if (Object.keys(fields).length) trace('model.usage', fields)
}

export function traceTurn<T>(fields: Fields, work: () => Promise<T>): Promise<T> {
  const enabled = process.env.DESKHAND_AGENT_TRACE
  if (enabled === '0' || (process.env.VITEST && enabled !== '1')) return work()
  const path = join(app.getPath('userData'), 'agent-trace.jsonl')
  const revision = process.env.DESKHAND_TRACE_REVISION
  const store: Turn = { id: randomUUID(), path, started: performance.now(), nextSpan: 0 }
  open.add(store)
  return turn.run(store, () => timed('turn', work, {
    ...fields, schema: 2, build: app.getVersion?.() ?? 'unknown',
    revision: revision && /^[a-f0-9]{7,40}$/.test(revision) ? revision : null
  // Closed only after the turn's own end event is written, so the last line is
  // not the one that loses its turn.
  })).finally(() => {
    open.delete(store)
  })
}

/**
 * Runs `work` with a turn, reusing the caller's if there is one.
 *
 * A `trace()` outside a turn is dropped without a word, which is the right
 * default for a hot path but the wrong behaviour for a component that has
 * something worth recording: a run started from somewhere that did not think to
 * open a turn would leave no trace at all, and the absence looks exactly like
 * "nothing happened". This makes the recorder self-sufficient — the agent's
 * events land in the enclosing turn when there is one, and in a turn of their
 * own when there is not.
 */
export function traceWithin<T>(fields: Fields, work: () => Promise<T>): Promise<T> {
  // A live ambient turn is reused; a stale one is not. The distinction matters
  // because this is the path the agent controller takes from the card's request
  // handler, and a handler registered inside an earlier turn carries that dead
  // turn's context — reusing it would file this run under a turn that ended
  // minutes ago.
  const ambient = turn.getStore()
  if (ambient && open.has(ambient)) return work()
  return traceTurn(fields, work)
}
