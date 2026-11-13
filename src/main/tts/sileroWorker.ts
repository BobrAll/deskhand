/**
 * The long-lived Silero process.
 *
 * The weights are about 300 MB and the ONNX runtime takes a noticeable time to
 * import, so paying for both on every phrase is the slowest part of the local
 * voice. One process keeps the model in memory and receives jobs as newline
 * delimited JSON on stdin; `worker_tts.py` answers with a `DESKHAND` line.
 *
 * The process is disposable by design: a timeout, a crash or a garbled reply
 * kills it, rejects the waiting request, and the next request starts a fresh
 * one. Every failure is also handed to the one-shot renderer, so a machine with
 * an unusual Python install still hears the line.
 */

import { firstLine } from './python'

export const WORKER_SCRIPT_NAME = 'worker_tts.py'

/**
 * Loads the model once and serves requests until stdin closes.
 *
 * The library is free to print to stdout; its output is sent to stderr before
 * the import so only protocol lines reach the pipe the app reads.
 */
export const WORKER_SCRIPT = `import json
import sys

PREFIX = "DESKHAND "
PROTOCOL = sys.stdout
sys.stdout = sys.stderr

from silero_onnx import SileroTTS


def reply(payload):
    PROTOCOL.write(PREFIX + json.dumps(payload) + "\\n")
    PROTOCOL.flush()


def main():
    models, speaker = sys.argv[1:3]
    tts = SileroTTS(model_dir=models)
    for raw in sys.stdin:
        line = raw.strip()
        if not line:
            continue
        try:
            job = json.loads(line)
            job_id = job["id"]
            text = job["text"]
            output = job["output"]
        except Exception as error:
            reply({"id": None, "ok": False, "error": "bad request: " + str(error)})
            continue
        try:
            tts.synthesize_to_file(text, output, speaker=speaker)
            reply({"id": job_id, "ok": True})
        except Exception as error:
            reply({"id": job_id, "ok": False, "error": str(error)})


if __name__ == "__main__":
    raise SystemExit(main())
`

const REPLY_PREFIX = 'DESKHAND '
const STDERR_TAIL_CHARS = 2000
const LOG_LINE_CHARS = 300
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000
const DEFAULT_IDLE_TIMEOUT_MS = 3 * 60_000

/** The part of `ChildProcess` this module uses, so a test can stand in for it. */
export interface SileroWorkerChild {
  stdin: {
    write(chunk: string): unknown
    on?(event: 'error', listener: (error: Error) => void): unknown
  } | null
  stdout: NodeJS.ReadableStream | null
  stderr: NodeJS.ReadableStream | null
  kill(signal?: NodeJS.Signals): boolean
  on(event: 'error', listener: (error: Error) => void): unknown
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown
}

export interface SileroWorkerOptions {
  spawnWorker: () => SileroWorkerChild
  requestTimeoutMs?: number
  idleTimeoutMs?: number
  log?: (message: string) => void
  /** Called when a request timed out; the caller can stop using this worker for a while. */
  onTimeout?: () => void
}

interface Job {
  text: string
  output: string
  fallback: () => Promise<void>
  /** Runs after an `ok` reply, still inside the queue, before the next phrase. */
  verify?: () => Promise<void>
  resolve: () => void
  reject: (error: Error) => void
}

interface PendingRequest {
  id: number
  resolve: () => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

interface Reply {
  id: number
  ok: boolean
  error?: string
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

function isReply(value: unknown): value is Reply {
  if (typeof value !== 'object' || value === null) return false
  const reply = value as Record<string, unknown>
  return (
    typeof reply.id === 'number' &&
    typeof reply.ok === 'boolean' &&
    (reply.error === undefined || typeof reply.error === 'string')
  )
}

/**
 * Serializes jobs through one warm process and replaces it after a failure.
 *
 * A job is only finished after its fallback, if one is needed, so two Python
 * processes never load the model at the same time.
 */
export class SileroWorker {
  private readonly spawnWorker: () => SileroWorkerChild
  private readonly requestTimeoutMs: number
  private readonly idleTimeoutMs: number
  private readonly log: (message: string) => void
  private readonly onTimeout: (() => void) | undefined

  private child: SileroWorkerChild | null = null
  private buffer = ''
  private stderr = ''
  private queue: Job[] = []
  private pending: PendingRequest | null = null
  private idleTimer: NodeJS.Timeout | null = null
  private nextId = 1
  private busy = false
  private stopped = false

  constructor(options: SileroWorkerOptions) {
    this.spawnWorker = options.spawnWorker
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS
    this.log = options.log ?? ((message) => console.warn(message))
    this.onTimeout = options.onTimeout
  }

  /** Queues one phrase; `fallback` renders it again when the worker fails. */
  render(
    text: string,
    output: string,
    fallback: () => Promise<void>,
    verify?: () => Promise<void>
  ): Promise<void> {
    this.stopped = false
    return new Promise((resolve, reject) => {
      this.queue.push({ text, output, fallback, verify, resolve, reject })
      this.pump()
    })
  }

  /** Kills the process and rejects everything waiting; the next render respawns. */
  stop(): void {
    this.stopped = true
    this.clearIdle()
    const error = new Error('Silero worker остановлен.')
    const queued = this.queue
    this.queue = []
    for (const job of queued) job.reject(error)
    this.failPending(error)
    this.resetChild('SIGKILL')
  }

  private pump(): void {
    if (this.busy) return
    const job = this.queue.shift()
    if (!job) return
    this.busy = true
    void this.run(job)
      .then(job.resolve, job.reject)
      .finally(() => {
        this.busy = false
        this.pump()
        if (!this.busy) this.scheduleIdle()
      })
  }

  private async run(job: Job): Promise<void> {
    try {
      await this.synthesize(job.text, job.output)
      // A worker can answer `ok` and still leave no usable file. The check is
      // inside the queued job so the one-shot fallback never loads a second
      // model alongside this warm child.
      if (job.verify) await job.verify()
    } catch (workerError) {
      if (this.stopped) throw workerError
      const message = asError(workerError).message
      this.log(`[tts] silero worker failed (${message}); using the one-shot renderer`)
      await job.fallback()
    }
  }

  private synthesize(text: string, output: string): Promise<void> {
    return new Promise((resolve, reject) => {
      let child: SileroWorkerChild
      try {
        child = this.ensureChild()
      } catch (error) {
        reject(asError(error))
        return
      }
      if (!child.stdin) {
        const error = new Error('Silero worker не принял запрос.')
        this.loseChild(error)
        reject(error)
        return
      }

      const id = this.nextId++
      const timer = setTimeout(() => {
        if (this.pending?.id !== id) return
        this.onTimeout?.()
        this.loseChild(new Error('Синтез не ответил вовремя.'))
      }, this.requestTimeoutMs)
      timer.unref()
      this.pending = { id, resolve, reject, timer }

      try {
        child.stdin.write(`${JSON.stringify({ id, text, output })}\n`)
      } catch (error) {
        this.loseChild(asError(error))
      }
    })
  }

  private ensureChild(): SileroWorkerChild {
    if (this.child) return this.child
    this.buffer = ''
    this.stderr = ''
    const child = this.spawnWorker()
    this.child = child

    // A dead child makes `stdin.write` emit EPIPE asynchronously; without this
    // listener Node treats it as an unhandled stream error and can take the app
    // down while the card is only waiting for a phrase.
    child.stdin?.on?.('error', (error) => {
      if (this.child === child) this.loseChild(asError(error))
    })
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      if (this.child === child) this.consume(chunk)
    })
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => {
      if (this.child === child) this.stderr = (this.stderr + chunk).slice(-STDERR_TAIL_CHARS)
    })
    child.on('error', (error) => {
      if (this.child === child) this.loseChild(error)
    })
    child.on('exit', (code, signal) => {
      if (this.child !== child) return
      const detail = firstLine(this.stderr)
      this.loseChild(new Error(detail || `Silero worker завершился (${signal ?? code ?? 'без кода'}).`))
    })
    return child
  }

  private consume(chunk: string): void {
    this.buffer += chunk
    for (;;) {
      const newline = this.buffer.indexOf('\n')
      if (newline < 0) return
      const line = this.buffer.slice(0, newline)
      this.buffer = this.buffer.slice(newline + 1)
      this.handleLine(line)
    }
  }

  private handleLine(line: string): void {
    const text = line.trim()
    if (!text) return
    const at = text.lastIndexOf(REPLY_PREFIX)
    if (at < 0) {
      // The script redirects library output to stderr, but an odd install may
      // still write to stdout; it must not look like a protocol reply.
      this.log(`[tts] silero worker stdout: ${text.slice(0, LOG_LINE_CHARS)}`)
      return
    }
    if (at > 0) {
      // A C extension can write to fd 1 without a newline. The reply is still
      // complete, so keep it and log the prefix as noise.
      this.log(`[tts] silero worker stdout: ${text.slice(0, at).slice(0, LOG_LINE_CHARS)}`)
    }

    const pending = this.pending
    if (!pending) {
      this.log(`[tts] silero worker replied with no request waiting: ${text.slice(at).slice(0, LOG_LINE_CHARS)}`)
      return
    }

    let reply: unknown
    try {
      reply = JSON.parse(text.slice(at + REPLY_PREFIX.length))
    } catch {
      this.loseChild(new Error('Silero ответил непонятно.'))
      return
    }
    if (!isReply(reply) || reply.id !== pending.id) {
      this.loseChild(new Error('Silero ответил не на тот запрос.'))
      return
    }
    if (reply.ok) {
      this.finishPending()
      return
    }
    this.failPending(new Error(reply.error || 'Silero не смог озвучить текст.'))
  }

  private finishPending(): void {
    const pending = this.pending
    if (!pending) return
    this.pending = null
    clearTimeout(pending.timer)
    pending.resolve()
  }

  private failPending(error: Error): void {
    const pending = this.pending
    if (!pending) return
    this.pending = null
    clearTimeout(pending.timer)
    pending.reject(error)
  }

  private loseChild(error: Error): void {
    this.resetChild('SIGKILL')
    this.failPending(error)
  }

  private resetChild(signal: NodeJS.Signals): void {
    this.clearIdle()
    this.buffer = ''
    const child = this.child
    this.child = null
    if (!child) return
    try {
      child.kill(signal)
    } catch {
      // Already gone; the pending request, if any, is rejected by the caller.
    }
  }

  private scheduleIdle(): void {
    this.clearIdle()
    if (!this.child) return
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null
      if (this.busy || this.queue.length > 0) return
      this.resetChild('SIGTERM')
    }, this.idleTimeoutMs)
    this.idleTimer.unref()
  }

  private clearIdle(): void {
    if (!this.idleTimer) return
    clearTimeout(this.idleTimer)
    this.idleTimer = null
  }
}
