/**
 * The process half of a long-lived native listener.
 *
 * `voice/listen.ts` wraps a helper command that owns a macOS event source,
 * prints one JSON line per edge, and blocks in a run loop until it is signalled.
 * This class is the keep-alive around that: spawn with piped stdio, parse JSON
 * lines, remember whether the child ever reported `ready`, restart on an
 * unexpected exit with a capped exponential backoff, and refuse to spin when the
 * failure is one that will not fix itself in a second.
 *
 * What the subclass supplies is everything the command decides for itself:
 * `args()`, `describeError()`, what to do when the child dies before `ready`,
 * and whether `stop()` should forget the combination it was started with.
 *
 * The known backoff defect (`failures` is reset by every `ready`, so the cap is
 * unreachable in practice) lives here; the characterization tests in
 * `listen.test.ts` pin it.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { createInterface } from 'node:readline'

/** One line of helper output. `error` and `event` never arrive together. */
interface HelperLine<Event extends string> {
  ok?: boolean
  event?: Event
  error?: string
}

/** How many restarts in a row before the listener gives up. */
const MAX_FAILURES = 6

export abstract class TapListener<Event extends string> {
  private child: ChildProcess | null = null
  private stopped = true
  private restartTimer: NodeJS.Timeout | null = null
  private failures = 0
  /** Set when the listener could not start; surfaced in the settings window. */
  lastError: string | null = null

  protected constructor(
    /**
     * The helper binary. A function for the callers that can only resolve it
     * after the app has been built, and because a missing binary is a normal
     * state on a fresh checkout rather than a crash.
     */
    private readonly binary: string | (() => string),
    private readonly onEvent: (event: Event) => void,
    private readonly onError: (message: string) => void
  ) {}

  private binaryPath(): string {
    return typeof this.binary === 'function' ? this.binary() : this.binary
  }

  /** True while the helper process is up. */
  get listening(): boolean {
    return this.child !== null && !this.child.killed
  }

  /** Command name and its arguments, e.g. `['voice', '49', '524288']`. */
  protected abstract args(): string[]

  /** Turns a helper error code into the sentence the settings window shows. */
  protected abstract describeError(code: string): string

  /** Prefix for `console.warn`, so the log says which listener spoke. */
  protected abstract readonly tag: string

  /** Message used when `spawn` throws something that is not an `Error`. */
  protected abstract readonly spawnFailure: string

  /** `spawn` threw: nothing was started. */
  protected abstract onSpawnThrown(message: string): void

  /** The process died before ever reporting `ready`. */
  protected abstract onExitWithoutReady(): void

  /** Clears the restart bookkeeping and marks the listener as wanted. */
  protected startTap(): void {
    this.stopped = false
    this.failures = 0
    this.launch()
  }

  protected launch(): void {
    const binary = this.binaryPath()
    if (!binary) {
      this.onSpawnThrown(this.spawnFailure)
      return
    }
    let child: ChildProcess
    try {
      child = spawn(binary, this.args(), { stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      this.onSpawnThrown(error instanceof Error ? error.message : this.spawnFailure)
      return
    }
    this.child = child

    const reader = createInterface({ input: child.stdout! })
    let reportedReady = false

    reader.on('line', (line) => {
      const text = line.trim()
      if (!text) return
      let payload: HelperLine<Event>
      try {
        payload = JSON.parse(text) as HelperLine<Event>
      } catch {
        return
      }
      if (payload.error) {
        this.lastError = this.describeError(payload.error)
        this.onError(this.lastError)
        return
      }
      if (payload.event === 'ready') {
        reportedReady = true
        this.failures = 0
        this.lastError = null
      }
      if (payload.event) this.onEvent(payload.event)
    })

    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString().trim()
      if (text) console.warn(`[${this.tag}] listener:`, text.split('\n')[0])
    })

    child.on('exit', (code) => {
      reader.close()
      if (this.child === child) this.child = null
      if (this.stopped) return
      // A start that never reported `ready` failed for a reason that will not fix
      // itself in a second; retrying that in a loop would only fill the log.
      if (!reportedReady) {
        this.onExitWithoutReady()
        return
      }
      console.warn(`[${this.tag}] listener exited with ${code}; restarting`)
      this.scheduleRestart()
    })

    child.on('error', (error) => {
      if (this.child === child) this.child = null
      if (this.stopped) return
      this.lastError = error.message
      this.onError(error.message)
      this.scheduleRestart()
    })
  }

  private scheduleRestart(): void {
    if (this.stopped || this.restartTimer) return
    this.failures += 1
    if (this.failures > MAX_FAILURES) return
    // 1s, 2s, 4s… capped at 30s: long enough not to spin, short enough that a
    // permission granted mid-session revives the listener without a restart.
    const delayMs = Math.min(30_000, 1000 * 2 ** (this.failures - 1))
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      if (!this.stopped) this.launch()
    }, delayMs)
  }

  /** Stops the tap. The helper blocks in a run loop, so it has to be signalled. */
  stop(): void {
    this.stopped = true
    if (this.restartTimer) {
      clearTimeout(this.restartTimer)
      this.restartTimer = null
    }
    if (this.child) {
      this.child.kill('SIGTERM')
      this.child = null
    }
  }
}
