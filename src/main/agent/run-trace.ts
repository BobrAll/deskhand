import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app } from 'electron'

/** One warning per process: a failing trace must not flood the log once per row. */
let warnedOnce = false

/** What `openTrace` hands back: append one row, then close the file. */
interface RunTraceWriter {
  record(row: unknown): void
  close(): Promise<void>
}

function openTrace(directory: string, filename: string): RunTraceWriter {
  const path = join(directory, filename)
  let writes = mkdir(directory, { recursive: true, mode: 0o700 })
    .then(() => writeFile(path, '[\n', { mode: 0o600, flag: 'wx' }))
  let first = true
  let failed = false

  function enqueue(content: () => string): void {
    writes = writes.then(async () => {
      if (!failed) await appendFile(path, content())
    }).catch(() => {
      failed = true
      if (!warnedOnce) console.warn('[agent run trace] Unable to write the local trace')
      warnedOnce = true
    })
  }

  function record(row: unknown): void {
    const separator = first ? '' : ',\n'
    first = false
    enqueue(() => separator + JSON.stringify(row, null, 2).replace(/^/gm, '  '))
  }

  async function close(): Promise<void> {
    enqueue(() => '\n]\n')
    await writes
  }

  return { record, close }
}

/** One full trace and, if the model was called, one dialogue per agent request. */
export function createRunTrace() {
  const id = randomUUID()
  const started = performance.now()
  const timestamp = new Date().toISOString()
  const root = app.isPackaged === false ? app.getAppPath() : app.getPath('userData')
  const filename = `${timestamp.replace(/[:.]/g, '-')}-${id}.json`
  const trace = openTrace(join(root, 'agent-runs'), filename)
  let dialogue: RunTraceWriter | undefined

  function record(event: string, data: unknown): void {
    const row = {
      time: new Date().toISOString(),
      elapsedMs: Math.round(performance.now() - started),
      event,
      data
    }
    trace.record(row)
    if (event === 'model-request' || event === 'model-response') {
      dialogue ??= openTrace(join(root, 'agent-dialogs'), filename)
      dialogue.record(row)
    }
  }

  async function close(): Promise<void> {
    await Promise.all([trace.close(), dialogue?.close()])
  }

  return { id, record, close }
}
