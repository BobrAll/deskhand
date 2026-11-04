/**
 * Push-to-talk in the overlay renderer.
 *
 * The main process decides *when* a turn starts and ends (it owns the CGEventTap),
 * this hook owns the microphone and the visual state. Both sides talk through the
 * `voice` channels, so a failed recorder is reported the same way a failed
 * transcription is: one `VoiceEvent` that leaves the card in a known state.
 *
 * Two races are handled explicitly, because both happen on the first phrase of a
 * session and both look like "voice is broken":
 *
 * - the card is opened *by* the key press, so `record` can be broadcast before this
 *   component exists — the hook pulls the current phase on mount;
 * - the key can be released while the microphone is still opening — the release is
 *   remembered and applied as soon as the recorder is ready.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { VoiceEvent, VoicePhase } from '@shared/types'

/** The part of `recorder.ts` this hook uses, kept local to avoid an import cycle. */
interface Recorder {
  level(): number
  stop(capture: boolean): Promise<{ wavBase64: string; durationMs: number } | null>
}

export interface VoiceState {
  phase: VoicePhase
  /** 0..1, the loudness the main process forwards to the cursor chip. */
  level: number
  /**
   * Last outcome. Only a failure is rendered on the card: a successful
   * transcript is already in the input field, and repeating it under the field
   * read as a second answer.
   */
  message: string | null
  /** True when the message is a failure, not a transcript. */
  error: boolean
}

const IDLE: VoiceState = { phase: 'idle', level: 0, message: null, error: false }

/** How long a finished turn keeps its result on the card. */
const LINGER_MS = 1600

/** How often the meter is pushed to the main process. */
const LEVEL_MS = 80

export interface VoiceHook extends VoiceState {
  /** Push-to-talk is configured and the card should offer it. */
  available: boolean
  /**
   * False until `attach()` has answered.
   *
   * The window is shown by the main process at the same moment it starts a turn,
   * so the very first paint happens before this renderer knows a turn is running.
   * Drawing the card then would show the wrong one — the plain input line, a frame
   * before a voice turn replaces it with the bars — so every press flashed a panel
   * and then swapped it. The card waits instead: a transparent window with nothing
   * in it is exactly what the user should see for those few milliseconds.
   */
  ready: boolean
}

export function useVoice(): VoiceHook {
  const [state, setState] = useState<VoiceState>(IDLE)
  const [available, setAvailable] = useState(false)
  const [ready, setReady] = useState(false)
  const recorderRef = useRef<Recorder | null>(null)
  const lingerRef = useRef<number | null>(null)
  const levelTimerRef = useRef<number | null>(null)
  /** Set when the key was released before the microphone finished opening. */
  const pendingStopRef = useRef<boolean | null>(null)
  /**
   * True between "start opening the microphone" and the recorder being ready.
   *
   * The window can mount in the middle of a turn, and StrictMode mounts an effect
   * twice in development; without this guard both paths call `getUserMedia` and
   * the second recorder leaks a second microphone stream.
   */
  const openingRef = useRef(false)
  /**
   * Which capture the samples belong to.
   *
   * A new press can start while the previous recorder is still stopping, and
   * `recorder.stop()` is asynchronous. Without a token the *old* WAV would be
   * handed to the main process as the answer to the *new* phrase — and the new
   * turn would be transcribed into the previous words. Bumped for every capture;
   * a stop that finds itself out of date simply drops its audio.
   */
  const captureRef = useRef(0)
  /**
   * A press that arrived while the microphone was still opening.
   *
   * Only one can be queued: two presses before the first microphone is up are the
   * same phrase, and the newest budget is the one that counts. `beginCapture`
   * re-runs itself with this value once the open in flight settles.
   */
  const queuedRef = useRef<number | null>(null)
  /** Lets the opener restart itself without referring to its own `useCallback`. */
  const beginRef = useRef<(maxDurationMs: number) => void>(() => undefined)

  const clearLinger = useCallback(() => {
    if (lingerRef.current !== null) {
      window.clearTimeout(lingerRef.current)
      lingerRef.current = null
    }
  }, [])

  const stopMeter = useCallback(() => {
    if (levelTimerRef.current !== null) {
      window.clearInterval(levelTimerRef.current)
      levelTimerRef.current = null
    }
  }, [])

  /**
 * Why an early return here is not enough.
 *
 * The main process supersedes a turn the moment the key goes down again, so a
 * press that arrives while the previous recorder is still winding down *must*
 * produce a recording — otherwise the new turn has no audio, the card sits on
 * "recognising", and the watchdog has to close it. The work already in flight is
 * therefore queued, not dropped, and restarts the instant the microphone is free.
 */
  const beginCapture = useCallback(
    async (maxDurationMs: number) => {
      const api = window.smartCursor.voice
      if (recorderRef.current) {
        // Already recording: the same press arriving twice (a tap that was
        // re-armed, an autorepeat) is not a second phrase, and restarting the
        // microphone under the user would drop the words they just said.
        return
      }
      if (openingRef.current) {
        // The previous turn is still opening the microphone, or handing its WAV
        // back. Bailing out here is what left a press with *no* recording at all:
        // the main process had already moved to a new turn, so the card sat on
        // "recognising" until the watchdog gave up. Remember the press and start
        // the moment the open in flight settles.
        queuedRef.current = maxDurationMs
        return
      }
      openingRef.current = true
      captureRef.current += 1
      const mine = captureRef.current
      setState({ phase: 'listening', level: 0, message: null, error: false })
      try {
        const { startRecording } = await import('./recorder')
        const recorder = await startRecording(maxDurationMs)
        if (mine !== captureRef.current) {
          // A newer capture took over while this one was opening: this stream is
          // not the one the user is speaking into.
          await recorder.stop(false)
          return
        }
        recorderRef.current = recorder
        levelTimerRef.current = window.setInterval(() => {
          const current = recorderRef.current
          if (current) api.level(current.level())
        }, LEVEL_MS)

        const pending = pendingStopRef.current
        if (pending !== null) {
          // The key came up while `getUserMedia` was still resolving: honour it
          // now instead of recording until the next press.
          pendingStopRef.current = null
          stopMeter()
          recorderRef.current = null
          const audio = await recorder.stop(pending)
          if (mine === captureRef.current) {
            await api.recorded(audio?.wavBase64 ?? '', audio?.durationMs ?? 0)
          }
        }
      } catch (error) {
        // A stop that arrived while the microphone was opening belongs to this
        // failed turn; keeping it would make the *next* press stop instantly.
        pendingStopRef.current = null
        const message =
          error instanceof DOMException && error.name === 'NotAllowedError'
            ? 'Нет доступа к микрофону — разрешите его в настройках macOS.'
            : error instanceof Error
              ? error.message
              : 'Микрофон недоступен.'
        api.failed(message)
      } finally {
        openingRef.current = false
        const queued = queuedRef.current
        queuedRef.current = null
        // A press that arrived during this open still has to be recorded. It is
        // started from here, in the same tick the microphone became free, so the
        // delay is a microtask and not the tail of a recognition.
        if (queued !== null && !recorderRef.current) beginRef.current(queued)
      }
    },
    [stopMeter]
  )
  beginRef.current = (maxDurationMs) => {
    void beginCapture(maxDurationMs)
  }

  /** Closes the turn: stops the recorder and hands the WAV back to the main process. */
  const endCapture = useCallback(
    async (transcribe: boolean) => {
      const api = window.smartCursor.voice
      stopMeter()
      const recorder = recorderRef.current
      if (!recorder) {
        // Still opening — or queued behind an open that has not settled: remember
        // the decision, the opener applies it the moment the microphone is up.
        // Otherwise the stop is stale (the microphone never started) and must not
        // be carried into the next press.
        if (openingRef.current || queuedRef.current !== null) pendingStopRef.current = transcribe
        return
      }
      recorderRef.current = null
      const mine = captureRef.current
      const audio = await recorder.stop(transcribe)
      // A press that arrived while this recorder was winding down has already
      // started the next capture; its samples are the ones the user meant, and
      // handing over this WAV instead would answer the old phrase with the new
      // turn's card.
      if (mine !== captureRef.current) return
      await api.recorded(audio?.wavBase64 ?? '', audio?.durationMs ?? 0)
    },
    [stopMeter]
  )

  useEffect(() => {
    const api = window.smartCursor.voice

    const offRecord = api.onRecord((request) => {
      clearLinger()
      void beginCapture(request.maxDurationMs)
    })

    const offStop = api.onStop((request) => {
      void endCapture(request.transcribe)
    })

    const offEvent = api.onEvent((event: VoiceEvent) => {
      setState((prev) => ({
        ...prev,
        phase: event.phase,
        level: event.phase === 'listening' ? event.level : 0,
        message: event.text ?? event.error ?? (event.phase === 'idle' ? prev.message : null),
        error: Boolean(event.error)
      }))
      if (event.phase === 'idle' && (event.text || event.error)) {
        clearLinger()
        lingerRef.current = window.setTimeout(() => {
          setState((prev) => (prev.phase === 'idle' ? { ...prev, message: null, error: false } : prev))
        }, LINGER_MS)
      }
    })

    // The press that opened this card happened before this component existed, so
    // the `record` broadcast may have been missed. Pulling the phase closes that
    // window; without it the first turn of every session records nothing.
    void api.attach().then((pending) => {
      if (pending.phase === 'listening' && !recorderRef.current) {
        void beginCapture(pending.maxDurationMs)
      } else if (pending.phase === 'transcribing') {
        // The key came up (or the recorder finished) before this component
        // subscribed. The bars still have to be there for the rest of the
        // recognition — otherwise a short phrase shows no animation at all.
        setState({ phase: 'transcribing', level: 0, message: null, error: false })
      }
      setReady(true)
    })

    // The hint is only offered when a hotkey actually exists: advertising voice on
    // a machine without a model or a tap would be a lie.
    void api.status().then((status) => {
      setAvailable(status.ready && status.listenerError === null)
    })

    return () => {
      offRecord()
      offStop()
      offEvent()
      clearLinger()
      stopMeter()
      void recorderRef.current?.stop(false)
      recorderRef.current = null
      openingRef.current = false
    }
  }, [beginCapture, clearLinger, endCapture, stopMeter])

  return { ...state, available, ready }
}
