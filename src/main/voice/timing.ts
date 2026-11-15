import type { VoiceErrorCode, VoiceEvent, VoicePhase } from '@shared/types'
import { getSettings } from '../settings/store'

const POLL_MS = 100
/**
 * How often a running turn checks whether it has outstayed its welcome.
 *
 * The ceiling itself is a setting (`voice.maxDurationMs`), read at check time and
 * not at press time, so a turn is still closed on time if the value changed while
 * the key was down. A quarter second is far below anything a person perceives as
 * "stuck" and costs one comparison per tick.
 */
const WATCHDOG_MS = 250
/**
 * How long the card waits for the renderer to hand over a finished recording.
 *
 * Between the key-up and `voice:recorded` there is only local work — stopping the
 * recorder, encoding a WAV of at most two minutes — so this is measured in
 * seconds, with room for a page that is still opening the microphone after a press
 * that landed during a previous turn's hand-over. Without it a recorder that never
 * answers leaves the card flashing "recognising" forever and, because a press is
 * refused while a turn runs, swallows every later press too. Five seconds is well
 * past any honest encode and short enough that the card does not look frozen.
 */
const RECORDING_TIMEOUT_MS = 5_000
/**
 * Floor for one recognition. The WAV is local and whisper runs on this machine,
 * so this only fires when the child process hangs or never reports back.
 *
 * It is a floor, not the whole budget: a flat ceiling aborted a long dictation
 * mid-recognition and threw the audio away, so the budget grows with the
 * recording (see `transcribeBudget`).
 */
const TRANSCRIBE_TIMEOUT_MS = 30_000

/**
 * How long one recognition may take, given how much audio it was handed.
 *
 * Twice the recording is generous for a local model that runs faster than real
 * time, and it still bounds a recognizer that never answers. Anything that is
 * not a plausible duration falls back to the floor.
 */
function transcribeBudget(durationMs: number): number {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return TRANSCRIBE_TIMEOUT_MS
  return Math.max(TRANSCRIBE_TIMEOUT_MS, Math.round(durationMs * 2))
}

interface VoiceTimingHost {
  currentTurn(): number
  recognizing(): boolean
  expire(message: string, code: VoiceErrorCode): void
  emit(event: VoiceEvent): void
  fieldLevel(value: number): void
}

export function createVoiceTiming({ currentTurn, recognizing, expire, emit, fieldLevel }: VoiceTimingHost) {
  let phase: VoicePhase = 'idle'
  let startedAt = 0
  let level = 0
  let poller: NodeJS.Timeout | null = null
  let transcribeBudgetMs = TRANSCRIBE_TIMEOUT_MS
  /** Closes a turn that overstays `maxDurationMs` while the microphone is open. */
  let listeningWatchdog: NodeJS.Timeout | null = null
  /** Closes a turn whose recording never came back, or whose whisper hung. */
  let recordingTimer: NodeJS.Timeout | null = null
  function publish(event: Partial<VoiceEvent> & { phase: VoicePhase }): void {
    const payload: VoiceEvent = {
      phase: event.phase,
      level: event.level ?? level,
      text: event.text,
      error: event.error,
      code: event.code
    }
    emit(payload)
  }

  function setPhase(next: VoicePhase, extra?: { text?: string; error?: string; code?: VoiceErrorCode }): void {
    phase = next
    startedAt = Date.now()
    level = 0
    armWatchdog()
    if (next === 'idle') {
      if (poller) clearInterval(poller)
      poller = null
    } else if (!poller) {
      // The level meter on the chip and the bars in the card; 10 Hz is enough for
      // both and costs nothing next to the audio pipeline.
      poller = setInterval(() => publish({ phase }), POLL_MS)
    }
    publish({ phase: next, ...extra })
  }

  /**
   * Keeps a turn from running forever.
   *
   * Two things can leave the card animating with nothing behind it: the key-up
   * event is lost (the tap was disabled by macOS mid-press, the helper died, the
   * key was released while the app was blocked), or the renderer never reports
   * the finished recording. Both used to be permanent — `phase` stayed non-idle,
   * and since a press is refused while a turn runs, every later press was
   * swallowed too. The only cure was restarting the app, so the card looked
   * broken rather than busy.
   *
   * The listening ceiling is read on every tick instead of being frozen at the
   * press: `maxDurationMs` is a setting, and a turn must honour the value in force
   * now, not the one that happened to be stored when the key went down.
   */
  function armWatchdog(): void {
    if (listeningWatchdog) clearInterval(listeningWatchdog)
    if (recordingTimer) clearTimeout(recordingTimer)
    listeningWatchdog = null
    recordingTimer = null
    if (phase === 'idle') return

    if (phase === 'listening') {
      const mine = currentTurn()
      listeningWatchdog = setInterval(() => {
        if (mine !== currentTurn() || phase !== 'listening') {
          if (listeningWatchdog) clearInterval(listeningWatchdog)
          listeningWatchdog = null
          return
        }
        if (Date.now() - startedAt < getSettings().voice.maxDurationMs) return
        expire('Запись остановлена: слишком долго.', 'recordTooLong')
      }, WATCHDOG_MS)
      return
    }

    // `transcribing` has two halves with very different budgets: the hand-over
    // from the renderer (local work, milliseconds) and whisper itself (seconds on
    // a long phrase). `busy` says which half this is — it is set the moment the
    // recording arrives, and this function runs again at that point.
    const mine = currentTurn()
    const limit = recognizing() ? transcribeBudgetMs : RECORDING_TIMEOUT_MS
    recordingTimer = setTimeout(() => {
      if (mine !== currentTurn()) return
      expire(
        recognizing()
          ? 'Распознавание не ответило — попробуй ещё раз.'
          : 'Запись не дошла до распознавания — попробуй ещё раз.',
        recognizing() ? 'transcribeFailed' : 'recordFailed'
      )
    }, limit)
  }

  /** False when the user tapped the key instead of holding it. */
  function longEnough(): boolean {
    return Date.now() - startedAt >= getSettings().voice.minDurationMs
  }

  /** Loudness tick from the renderer, forwarded as-is into the overlay event. */
  function setLevel(value: number): void {
    if (phase !== 'listening') return
    level = Math.max(0, Math.min(1, value))
    fieldLevel(level)
  }

  function reset(): void {
    if (poller) clearInterval(poller)
    poller = null
    if (listeningWatchdog) clearInterval(listeningWatchdog)
    if (recordingTimer) clearTimeout(recordingTimer)
    listeningWatchdog = null
    recordingTimer = null
    phase = 'idle'
  }

  return {
    phase: () => phase,
    setPhase,
    longEnough,
    setLevel,
    reset,
    setRecordingDuration: (durationMs: number) => {
      transcribeBudgetMs = transcribeBudget(durationMs)
    }
  }
}
