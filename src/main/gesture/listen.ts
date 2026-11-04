/**
 * Long-lived listener around the native helper's `gesture` command.
 *
 * The helper owns the MultitouchSupport contact stream and prints one JSON line
 * per edge:
 *
 *   ready   — the trackpad is being watched
 *   tap     — three fingers touched and left before the hold threshold
 *   press   — three fingers have stayed down past the threshold: record
 *   release — they came up: stop recording, transcribe
 *   cancel  — a fourth finger, a swipe, or an ending the helper refused
 *
 * The classification lives in the helper because that is the side that sees the
 * frames: a quick tap often lifts before all three fingers share one 8 ms frame,
 * so only a whole contact — not a single frame — can tell a tap from a hold. This
 * module keeps the process alive the same way `voice/listen.ts` does for the
 * keyboard: restart on exit, stop cleanly, and report why it could not start.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { createInterface } from 'node:readline'

export type GestureEvent = 'tap' | 'press' | 'release' | 'cancel' | 'ready'

export interface GestureListenerOptions {
  binary: string
  /** Fingers in the gesture; three by default. */
  fingers: number
  /** How long they must stay down before a tap becomes a hold, in milliseconds. */
  holdMs: number
  onEvent(event: GestureEvent): void
  /** Fatal problems only: no trackpad, or the framework is unavailable. */
  onError(message: string): void
}

interface HelperLine {
  ok?: boolean
  event?: GestureEvent
  error?: string
}

export class TrackpadGestureListener {
  private child: ChildProcess | null = null
  private stopped = true
  private restartTimer: NodeJS.Timeout | null = null
  private failures = 0
  /** Set when the listener could not start; surfaced in the settings window. */
  lastError: string | null = null

  constructor(private readonly options: GestureListenerOptions) {}

  /** True while the helper process is up. */
  get listening(): boolean {
    return this.child !== null && !this.child.killed
  }

  /**
   * Starts (or restarts) the listener. Returns an error message when gestures
   * cannot be watched on this machine, so the settings window can say so instead
   * of leaving a switch that silently does nothing.
   */
  start(): string | null {
    this.stop()
    this.stopped = false
    this.failures = 0
    this.launch()
    return null
  }

  private launch(): void {
    const args = [
      'gesture',
      String(this.options.fingers),
      String(Math.round(this.options.holdMs))
    ]

    let child: ChildProcess
    try {
      child = spawn(this.options.binary, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Не удалось запустить слушатель жестов.'
      this.lastError = message
      this.options.onError(message)
      return
    }
    this.child = child

    const reader = createInterface({ input: child.stdout! })
    let reportedReady = false

    reader.on('line', (line) => {
      const text = line.trim()
      if (!text) return
      let payload: HelperLine
      try {
        payload = JSON.parse(text) as HelperLine
      } catch {
        return
      }
      if (payload.error) {
        this.lastError = describeGestureError(payload.error)
        this.options.onError(this.lastError)
        return
      }
      if (payload.event === 'ready') {
        reportedReady = true
        this.failures = 0
        this.lastError = null
      }
      if (payload.event) this.options.onEvent(payload.event)
    })

    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString().trim()
      if (text) console.warn('[gesture] listener:', text.split('\n')[0])
    })

    child.on('exit', (code) => {
      reader.close()
      if (this.child === child) this.child = null
      if (this.stopped) return
      // A start that never reported `ready` failed for a reason that will not fix
      // itself in a second (no trackpad, a missing framework); retrying in a loop
      // would only fill the log with the same line.
      if (!reportedReady) return
      console.warn(`[gesture] listener exited with ${code}; restarting`)
      this.scheduleRestart()
    })

    child.on('error', (error) => {
      if (this.child === child) this.child = null
      if (this.stopped) return
      this.lastError = error.message
      this.options.onError(error.message)
      this.scheduleRestart()
    })
  }

  private scheduleRestart(): void {
    if (this.stopped || this.restartTimer) return
    this.failures += 1
    if (this.failures > 6) return
    // 1s, 2s, 4s… capped at 30s: long enough not to spin, short enough that a
    // trackpad which came back (a lid reopened, a device re-paired) is noticed.
    const delayMs = Math.min(30_000, 1000 * 2 ** (this.failures - 1))
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      if (!this.stopped) this.launch()
    }, delayMs)
  }

  /** Stops the listener. The helper blocks in a run loop, so it is signalled. */
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

function describeGestureError(code: string): string {
  if (code === 'no-trackpad') {
    return 'Трекпад не найден — жесты тремя пальцами недоступны, работают горячие клавиши.'
  }
  if (code === 'multitouch-unavailable') {
    return 'Система не отдаёт касания трекпада — жесты недоступны, работают горячие клавиши.'
  }
  return `Слушатель жестов: ${code}`
}
