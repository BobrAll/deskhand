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
const MAX_BYTES = 2 * 1024 * 1024
let writes = Promise.resolve()
let warned = false

export function trace(event: string, fields: Fields = {}): void {
  const current = turn.getStore()
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
  const current = turn.getStore()
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
  const enabled = process.env.SMART_CURSOR_AGENT_TRACE
  if (enabled === '0' || (process.env.VITEST && enabled !== '1')) return work()
  const path = join(app.getPath('userData'), 'agent-trace.jsonl')
  const revision = process.env.SMART_CURSOR_TRACE_REVISION
  return turn.run({ id: randomUUID(), path, started: performance.now(), nextSpan: 0 }, () => timed('turn', work, {
    ...fields, schema: 2, build: app.getVersion?.() ?? 'unknown',
    revision: revision && /^[a-f0-9]{7,40}$/.test(revision) ? revision : null
  }))
}
