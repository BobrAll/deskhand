import type { TranscribeResult, VoiceErrorCode } from '@shared/types'
import { getSettings } from '../settings/store'
import { transcribe } from './recognizer'
import type { createVoiceTiming } from './timing'
import type { createRecognizerWarmup } from './warmup'

/** What the overlay reports once it has stopped the recorder. */
export interface RecordingResult {
  /** 16 kHz mono 16-bit PCM WAV, base64. */
  wavBase64: string
  durationMs: number
}

interface RecordingHost {
  currentTurn(): number
  timing: Pick<ReturnType<typeof createVoiceTiming>, 'phase' | 'setPhase' | 'setRecordingDuration'>
  warmup: Pick<ReturnType<typeof createRecognizerWarmup>, 'markLoaded' | 'stopWarmup'>
  finishIdle(payload: { text?: string; error?: string; code?: VoiceErrorCode }): void
  applyTranscript(text: string): void
}

export function createVoiceRecording({ currentTurn, timing, warmup, finishIdle, applyTranscript }: RecordingHost) {
  let abort: AbortController | null = null
  /** Set while a transcript is in flight. */
  let busy = false
  /**
   * Drops the recognition in flight, if there is one.
   *
   * Aborting is not enough on its own — recognition is a child process that can
   * still answer — so a caller that must not apply its answer bumps `turn` as
   * well, and the late result is discarded because its turn is no longer the
   * current one.
   */
  function abortRecognition(): void {
    abort?.abort()
    abort = null
    busy = false
  }

  /**
   * Ends a turn that has nothing to recognise: no recorder at all, or silence.
   *
   * The card gets the sentence that explains it, and the renderer gets an answer
   * to its `voice:recorded` call. The two wordings differ because one is read by
   * a person and the other is only a log line in the caller.
   */
  function endTurnWithoutSpeech(code: VoiceErrorCode, error: string, message: string): TranscribeResult {
    busy = false
    finishIdle({ error, code })
    return { ok: false, text: '', ms: 0, message }
  }

  /** Called by the overlay once the recorder has stopped. */
  async function handleRecording(result: RecordingResult | null): Promise<TranscribeResult> {
    // A recording can only arrive for a turn that is waiting for one: `release`
    // either moved the turn to `transcribing` or ended it (a tap too short to be
    // a phrase, a cancelled turn, a turn the watchdog closed), and the renderer
    // answers both cases with a message. Applying the ones that arrive outside
    // `transcribing` is how a 40 ms tap used to report "ничего не расслышал" after
    // it had already been dismissed, and how the tail of an overtaken phrase could
    // end the phrase that replaced it.
    if (timing.phase() !== 'transcribing') {
      return { ok: false, text: '', ms: 0, message: 'Пропущено.' }
    }
    const mine = currentTurn()

    if (!result) {
      // No recorder at all: the microphone never opened.
      return endTurnWithoutSpeech('noMic', 'Запись не удалась — микрофон недоступен.', 'Запись не удалась.')
    }
    if (!result.wavBase64) {
      // The recorder ran but found no speech: silence, or a press too short to be
      // a phrase. An error message would be wrong — nothing failed.
      return endTurnWithoutSpeech('notHeard', 'Ничего не расслышал — попробуй ещё раз.', 'Речь не распознана.')
    }

    busy = true
    // The watchdog reads this when `setPhase` arms it below.
    timing.setRecordingDuration(result.durationMs)
    // This turn is about to load the model itself; a warm-up would be a second
    // copy of the same work. Cancel first: stopping drops the mark of the load it
    // interrupts, and this turn takes over from there.
    warmup.stopWarmup()
    const model = getSettings().voice.model
    const controller = new AbortController()
    abort = controller
    // `busy` is set first: `setPhase` arms the watchdog, and which budget applies
    // (`RECORDING_TIMEOUT_MS` vs `TRANSCRIBE_TIMEOUT_MS`) is exactly what `busy`
    // distinguishes.
    timing.setPhase('transcribing')
    try {
      const wav = Buffer.from(result.wavBase64, 'base64')
      const transcribed = await transcribe({ wav, signal: controller.signal })
      // Only a run that finished and was not cancelled has loaded the model; a
      // missing binary, a missing model, a failed temp-file write or an aborted
      // run has not.
      if (transcribed.spawned === true) warmup.markLoaded(model)
      // One line per turn: enough to diagnose a complaint, never the transcript
      // itself — what the user said is not log material. Audio length separates
      // "the model was slow" from "the phrase was long".
      console.log(
        `[voice] ${transcribed.ok ? 'ok' : 'failed'} in ${transcribed.ms} мс, ` +
          `${Math.round(result.durationMs)} мс аудио, модель ${model}`
      )
      if (mine !== currentTurn()) {
        // The user started another phrase while this one was being recognised.
        // The card already belongs to the newer turn, and both the text and the
        // phase would be wrong to apply here.
        return transcribed
      }
      if (controller.signal.aborted) {
        finishIdle({})
        return transcribed
      }
      if (!transcribed.ok) {
        finishIdle({ error: transcribed.message, code: 'transcribeFailed' })
        return transcribed
      }
      applyTranscript(transcribed.text)
      finishIdle({ text: transcribed.text })
      return transcribed
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Распознавание не удалось.'
      if (mine === currentTurn()) finishIdle({ error: message, code: 'transcribeFailed' })
      return { ok: false, text: '', ms: 0, message }
    } finally {
      // A recognition that replaced this one already cleared `busy` through
      // `abortRecognition()`; clearing it here would report the new one as idle.
      if (abort === controller) {
        abort = null
        busy = false
      }
    }
  }

  /** Reports a recorder failure (no microphone, permission denied). */
  function failed(message: string): void {
    busy = false
    finishIdle({ error: message, code: 'noMic' })
  }

  return { handleRecording, failed, abortRecognition, isBusy: () => busy }
}
