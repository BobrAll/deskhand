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
 * so only a whole contact — not a single frame — can tell a tap from a hold. The
 * keep-alive half (spawn, JSON lines, restarts, backoff) is the same one
 * `voice/listen.ts` uses and lives in `native/tapListener.ts`; what is here is
 * the argument list and the trackpad-specific failure texts.
 */

import { TapListener } from '../native/tapListener'

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

export class TrackpadGestureListener extends TapListener<GestureEvent> {
  constructor(private readonly options: GestureListenerOptions) {
    super(options.binary, options.onEvent, options.onError)
  }

  protected readonly tag = 'gesture'
  protected readonly spawnFailure = 'Не удалось запустить слушатель жестов.'

  protected args(): string[] {
    return [
      'gesture',
      String(this.options.fingers),
      String(Math.round(this.options.holdMs))
    ]
  }

  protected describeError(code: string): string {
    return describeGestureError(code)
  }

  protected onSpawnThrown(message: string): void {
    this.lastError = message
    this.options.onError(message)
  }

  protected onExitWithoutReady(): void {
    // No trackpad, or a missing framework: nothing that fixes itself in a
    // second, so the listener stays down and the switch in the settings window
    // keeps its last error instead of retrying into the log.
  }

  /**
   * Starts (or restarts) the listener. Returns an error message when gestures
   * cannot be watched on this machine, so the settings window can say so instead
   * of leaving a switch that silently does nothing.
   */
  start(): string | null {
    this.stop()
    this.startTap()
    return null
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
