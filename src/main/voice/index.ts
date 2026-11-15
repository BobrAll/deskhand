/**
 * The voice session: hold the key, speak, release, get text.
 *
 * A turn has three states, all mirrored into the overlay so the card can animate
 * instead of showing a spinner:
 *
 *   press   -> `listening`    the renderer starts recording from the microphone
 *   release -> `transcribing` the WAV goes to whisper-cli
 *   result  -> `idle`         the text is sent to the model, or typed into the app
 *
 * The keyboard comes from the CGEventTap in the native helper (Electron cannot
 * see a key *release*), the audio from the overlay renderer (it is the window
 * that holds the microphone permission), and recognition from a local whisper.cpp
 * process. Nothing on this path touches the network.
 */

import { CH } from '@shared/ipc'
import type { VoiceAction, VoiceErrorCode, VoicePhase } from '@shared/types'
import { pasteAnswer } from '../paste'
import { getSettings } from '../settings/store'
import type { TapEvent } from './listen'
import { createVoiceHotkeys, type VoiceBinding } from './hotkeys'
import { createVoiceRecording } from './recording'
import { createVoiceTiming } from './timing'
import { createRecognizerWarmup } from './warmup'
import { voiceStatus } from './recognizer'

/** What happens to a recognised transcript once it lands in the card. */
export interface DeliverOptions {
  /** Send it as a question instead of leaving it in the field. */
  submit: boolean
}

export interface VoiceHost {
  /** Builds the overlay renderer ahead of a turn, so the bars can be instant. */
  prewarm(): void
  /**
   * Shows the card; recording starts once the renderer reports it is recording.
   *
   * The card goes on screen before the context is collected — that ordering is
   * the overlay's own business now (see `openInternal`) — so this is the same
   * call the hotkey makes, and the bars simply replace the field while the turn
   * runs.
   */
  open(): Promise<void>
  /** True while the card is on screen, so a transcript can land in it. */
  isOpen(): boolean
  /**
   * Prepares a dictation hold without opening or focusing the card.
   *
   * Remembers the application that owns the keyboard right now — the one the
   * transcript will be pasted into — so the user's field keeps it for the whole
   * hold. The renderer must already be alive from `prewarm()`: the microphone
   * lives there.
   */
  beginDictation(): Promise<void>
  /** Reveals the bars without activating the card or collecting context again. */
  showIndicator(): void
  /** Feeds the field strip the same microphone level as the cursor bars. */
  fieldLevel(level: number): void
  /** Puts recognised text into an open card. */
  deliver(text: string, options: DeliverOptions): void
  /**
   * Ends a dictation turn and puts the screen back the way it was.
   *
   * `closeCard` is true for the primary hotkey configured to dictate: that path
   * opened and focused the card, so hiding the window is not enough — the card
   * has to be closed and focus returned to the app behind it.
   */
  endDictation(closeCard?: boolean): void
  /** Raw channel emit; the controller owns the voice protocol. */
  emit(channel: string, payload: unknown): void
  /**
   * Tells the card to drop its glass while the turn runs: the bars replace the
   * field, and a frosted rectangle behind them would be a panel that is not there.
   */
  setVoice(active: boolean): void
  /** The application the card belongs to: dictation pastes back into it. */
  target(): Parameters<typeof pasteAnswer>[1] | null
}

export type { RecordingResult } from './recording'

/** A short tap ends without a recognition; try warming again after it. */
const WARMUP_RETRY_MS = 1_500

export function createVoiceController(host: VoiceHost) {
  /**
   * What the turn in flight does with its transcript.
   *
   * Read at press time rather than at delivery time: the dictation hotkey means
   * "always type here", while the main one follows whatever `action` says.
   */
  let turnAction: VoiceAction | null = null
  /**
   * Which hold started the turn.
   *
   * The primary hotkey can also be configured to dictate. That path opens and
   * focuses the card, so it must end through `close()` — unlike the dedicated
   * dictation hold, which never opened one.
   */
  let turnBinding: VoiceBinding | null = null
  /**
   * Identifies the turn that owns the card right now.
   *
   * Recognition is asynchronous and the user can start speaking again before it
   * returns; the answer that arrives late belongs to a turn that no longer exists.
   * Every turn bumps this, and a result is applied only if its turn is still the
   * current one — that is what keeps a stale phrase from ending (or answering
   * into) the new one.
   */
  let turn = 0
  // Timing and warm-up need to ask whether a recognition is in flight, while the
  // recorder needs both of them. The callbacks only run after the wiring below.
  let recording: ReturnType<typeof createVoiceRecording> | null = null
  const timing = createVoiceTiming({
    currentTurn: () => turn,
    recognizing: () => recording?.isBusy() ?? false,
    expire: abortTurnWithError,
    emit: (event) => host.emit(CH.voice.event, event),
    fieldLevel: (value) => host.fieldLevel(value)
  })
  const { setPhase, longEnough } = timing
  const warmup = createRecognizerWarmup(() => timing.phase() === 'idle' && !(recording?.isBusy() ?? false))
  const { scheduleWarmup, stopWarmup } = warmup
  recording = createVoiceRecording({ currentTurn: () => turn, timing, warmup, finishIdle, applyTranscript })
  const { abortRecognition, handleRecording, failed, isBusy: recognitionBusy } = recording
  const hotkeys = createVoiceHotkeys({
    handleTapEvent,
    onModel: warmup.updateModel,
    onDisabled: () => {
      if (timing.phase() !== 'idle' || turnAction !== null) void onCancel()
    },
    onTapsStopped: scheduleWarmup,
    onUnavailable: stopWarmup,
    onTapsReady: () => {
      host.prewarm()
      scheduleWarmup()
    }
  })

  /**
   * Abandons the turn in flight and puts its reason on the card.
   *
   * The watchdog paths end a turn that nobody is driving any more; `finishIdle`
   * is the ordinary ending, for a turn that produced a transcript or was
   * dismissed.
   */
  function abortTurnWithError(message: string, code?: VoiceErrorCode): void {
    discardTurn()
    console.warn('[voice]', message)
    finishIdle({ error: message, code })
  }

  /**
   * Abandons the turn in flight and leaves the card to the next one.
   *
   * The recorder is stopped if it is still running, and the turn is bumped so a
   * recognition that answers late can no longer end this turn a second time.
   */
  function discardTurn(): void {
    turn += 1
    if (timing.phase() === 'listening') host.emit(CH.voice.stop, { transcribe: false })
    abortRecognition()
  }

  /** Ends the turn: one event carries both the new phase and its explanation. */
  function finishIdle(payload: { text?: string; error?: string; code?: VoiceErrorCode }): void {
    const action = turnAction ?? getSettings().voice.action
    const binding = turnBinding
    turnAction = null
    turnBinding = null
    host.setVoice(false)
    // Dictation never leaves anything on screen: the words went into the user's
    // own app, so a card would have nothing to show and would sit there as an
    // empty rectangle. This also covers the failed turns — a press that heard
    // nothing has no message worth a panel in the middle of the sentence. The
    // primary hotkey can dictate too, and it *did* open the card: that one has
    // to be closed, not just hidden.
    if (action === 'dictate') host.endDictation(binding === 'primary')
    setPhase('idle', payload)
    // A tap too short to transcribe never loaded the model; the idle moment after
    // it is the next chance to warm it.
    scheduleWarmup(WARMUP_RETRY_MS)
  }

  function handleTapEvent(event: TapEvent, binding: VoiceBinding): void {
    if (event === 'ready' || event === 'reenabled') return
    if (event === 'press') {
      void onPress(binding)
      return
    }
    // The edge carries the hold that produced it: with both hotkeys down, the
    // release or cancel of the other one must not end this turn.
    if (event === 'release') {
      void onRelease(binding)
      return
    }
    void onCancel(binding)
  }

  async function onPress(binding: VoiceBinding = 'primary'): Promise<void> {
    if (!getSettings().voice.enabled) return
    // The press is followed by a phrase that will load the same model; a warm-up
    // still holding it would only make that phrase wait.
    stopWarmup()
    // Already recording: the same physical press arriving twice (a tap that
    // was re-armed, an autorepeat) is not a new phrase.
    if (timing.phase() === 'listening') return
    if (timing.phase() === 'transcribing') {
      // The user is speaking again while the previous phrase is still in the
      // recogniser. This is the normal case for a person — say one thing,
      // correct it, say another — and refusing it meant the second phrase got
      // no animation and was silently dropped, which is exactly what "не всегда
      // анимация проигрывается" looked like from the outside.
      //
      // The turn in flight is superseded rather than queued: the new press owns
      // the card, and the old result is discarded when it returns (see the
      // `turn` check in `handleRecording`).
      abortRecognition()
      // A superseded dictation still owns the surface. The new turn has to be
      // free to open the card or show its own bars, so the old hold ends here
      // rather than at a `finishIdle` that will never run. A primary dictate
      // also opened the card and must close it, not merely hide it.
      if (turnAction === 'dictate') host.endDictation(turnBinding === 'primary')
    }
    turnAction = binding === 'dictation' ? 'dictate' : getSettings().voice.action
    turnBinding = binding
    // Recording starts *before* the card is prepared. Collecting the context
    // (window, selection, screenshot) takes a moment, and waiting for it would
    // swallow the first syllable — the one thing hold-to-talk must never lose.
    // The window is already alive from `prewarm()`, so this is a message, not a
    // page load.
    const mine = (turn += 1)
    setPhase('listening')
    // No panel while the microphone is open: the bars replace the field and the
    // window loses its glass entirely.
    host.setVoice(true)
    if (binding === 'dictation') {
      // The microphone lives in the overlay renderer, so a window destroyed
      // since the last turn has to be created — hidden, without taking focus.
      host.prewarm()
    }
    host.emit(CH.voice.record, { maxDurationMs: getSettings().voice.maxDurationMs })
    if (binding === 'dictation') {
      // A dictation must leave the keyboard exactly where it is. The card is
      // never opened: it collects the selection and then focuses itself, and
      // both would take the user out of their field mid-sentence. Only the
      // bars are shown, and only once the target app has been read.
      void showDictationIndicator(mine)
      return
    }
    // The card comes up in parallel and shows the listening state while it is
    // still being assembled; it is the same window, so no extra work is done.
    // It is shown before the context is collected: the bars are the only
    // feedback the user gets while speaking, and waiting for a selection read
    // (which can take a few hundred milliseconds) would delay them.
    if (!host.isOpen()) {
      // The card refused to open (the app is on the exclusion list, or the
      // context is unusable), or it threw before it ever could. Recording into a
      // card that will never exist would leave the microphone open with nowhere
      // to put the words, so both endings stop the recorder and close the turn.
      const stopWithoutCard = (): void => {
        if (host.isOpen() || timing.phase() !== 'listening' || mine !== turn) return
        host.emit(CH.voice.stop, { transcribe: false })
        finishIdle({})
      }
      void host.open().then(stopWithoutCard, stopWithoutCard)
    }
    // Do this after open has chosen between a fresh and an existing session:
    // making the old window visible first would resurrect a closed session.
    host.showIndicator()
  }

  /**
   * Reveals the dictation bars after the app that owns the keyboard is known.
   *
   * The order is the point: `showIndicator` orders our window in front, and the
   * target has to be read before anything of ours can look like the frontmost
   * app. A read that fails still leaves a usable turn — without a target the
   * transcript goes to the clipboard instead of a field.
   */
  async function showDictationIndicator(mine: number): Promise<void> {
    await host.beginDictation().catch(() => undefined)
    // The hold can end while the app is being read: a turn that is already idle
    // must not put its bars on screen after the key is up.
    if (mine !== turn || timing.phase() === 'idle') return
    host.showIndicator()
  }

  /**
   * Ends the turn, if the edge belongs to the hold that started it.
   *
   * An omitted binding means "the turn that is running", which is what the
   * programmatic `release()` helper means. The tap always names its hold.
   */
  async function onRelease(binding?: VoiceBinding): Promise<void> {
    if (timing.phase() !== 'listening') return
    if (binding && binding !== turnBinding) return
    if (!longEnough()) {
      // A tap on a hold-to-talk key is almost always a mistake; transcribing a
      // 40 ms blip would answer with "речь не распознана", which is worse.
      host.emit(CH.voice.stop, { transcribe: false })
      finishIdle({})
      return
    }
    setPhase('transcribing')
    // The renderer owns the samples: it stops the recorder and answers through
    // `handleRecording`. Keeping the state machine here, in one place, is what
    // makes Escape and a second press behave predictably.
    host.emit(CH.voice.stop, { transcribe: true })
  }

  async function onCancel(binding?: VoiceBinding): Promise<void> {
    // Escape while talking, or the tap was disabled by macOS. An edge with no
    // turn behind it must not touch the card: finishing an idle turn again would
    // erase the error the last one left there.
    if (timing.phase() === 'idle' && turnAction === null) return
    // The cancel must come from the hold that owns the card, or a stray edge of
    // the other one would abort a turn it never started.
    if (binding && binding !== turnBinding) return
    discardTurn()
    finishIdle({ error: hotkeys.listenerError() ?? undefined })
  }

  /** Routes the transcript according to the hold that started the turn. */
  function applyTranscript(text: string): void {
    const settings = getSettings()
    if ((turnAction ?? settings.voice.action) === 'dictate') {
      // Dictation never opened the card, and the target was read at press time
      // before any of our windows could take focus. The words therefore go back
      // into the field the user kept typing in — pasting must not depend on a
      // card having collected the app first.
      const target = host.target()
      void pasteAnswer(text, target)
      return
    }
    host.deliver(text, { submit: settings.voice.autoSend })
  }

  function stop(): void {
    // App shutdown or a full voice stop can land mid-hold; the surface must not
    // outlive the controller's state.
    if (turnAction === 'dictate') {
      host.endDictation(turnBinding === 'primary')
    }
    hotkeys.stop()
    abortRecognition()
    timing.reset()
    warmup.reset()
    turnAction = null
    turnBinding = null
  }

  async function status() {
    const base = await voiceStatus()
    return { ...base, listenerError: hotkeys.listenerError() }
  }

  /** Settings the overlay needs: whether to offer the hold-to-talk hint at all. Tests read it too. */
  function mode(): { enabled: boolean; action: 'command' | 'dictate'; hotkey: string } {
    const settings = getSettings()
    return {
      enabled: settings.voice.enabled,
      action: settings.voice.action,
      hotkey: settings.voice.hotkey
    }
  }

  /** Exists for tests: nothing outside them needs "is a turn running" as a single flag. */
  function isBusy(): boolean {
    return recognitionBusy() || timing.phase() !== 'idle'
  }

  /**
   * What a freshly mounted card should do.
   *
   * Push-to-talk opens the window on the key press, so the renderer mounts after
   * the `record` broadcast has already gone out. Without this the very first turn
   * of every session would silently not record.
   */
  function attach(): { phase: VoicePhase; maxDurationMs: number } {
    return { phase: timing.phase(), maxDurationMs: getSettings().voice.maxDurationMs }
  }

  /**
   * The three edges a hold produces, exposed for tests and for anything that
   * drives the state machine without a physical key.
   *
   * They go through exactly the same path as the tap, so Escape, the watchdog,
   * superseding and the transcript routing apply unchanged. Release and cancel
   * take the binding too; omitting it means "the turn that is running".
   */
  function press(binding: VoiceBinding = 'primary'): void {
    void onPress(binding)
  }

  function release(binding?: VoiceBinding): void {
    void onRelease(binding)
  }

  function cancel(binding?: VoiceBinding): void {
    void onCancel(binding)
  }

  return {
    applySettings: hotkeys.applySettings,
    stop,
    suspend: hotkeys.suspend,
    status,
    handleRecording,
    failed,
    setLevel: timing.setLevel,
    mode,
    isBusy,
    attach,
    press,
    release,
    cancel,
    /** Exists for tests: the renderer learns the phase from `attach()` and the events. */
    phase: timing.phase
  }
}

export type VoiceController = ReturnType<typeof createVoiceController>
