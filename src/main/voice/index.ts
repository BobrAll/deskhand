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
import type { TranscribeResult, VoiceAction, VoiceErrorCode, VoiceEvent, VoicePhase } from '@shared/types'
import { pasteAnswer } from '../paste'
import { getSettings } from '../settings/store'
import type { TapEvent } from './listen'
import { createVoiceHotkeys, type VoiceBinding } from './hotkeys'
import { createRecognizerWarmup } from './warmup'
import { transcribe, voiceStatus } from './recognizer'

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

/** What the overlay reports once it has stopped the recorder. */
export interface RecordingResult {
  /** 16 kHz mono 16-bit PCM WAV, base64. */
  wavBase64: string
  durationMs: number
}

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

/** A short tap ends without a recognition; try warming again after it. */
const WARMUP_RETRY_MS = 1_500

export function createVoiceController(host: VoiceHost) {
  let phase: VoicePhase = 'idle'
  let startedAt = 0
  let level = 0
  let poller: NodeJS.Timeout | null = null
  let abort: AbortController | null = null
  /** Set while a transcript is in flight. */
  let busy = false
  /**
   * How long the recognition in flight may take.
   *
   * Scaled from the recording that started it: a ten-second command and a
   * four-minute dictation must not share one ceiling.
   */
  let transcribeBudgetMs = TRANSCRIBE_TIMEOUT_MS
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
  /** Closes a turn that overstays `maxDurationMs` while the microphone is open. */
  let listeningWatchdog: NodeJS.Timeout | null = null
  /** Closes a turn whose recording never came back, or whose whisper hung. */
  let recordingTimer: NodeJS.Timeout | null = null
  const warmup = createRecognizerWarmup(() => phase === 'idle' && !busy)
  const { scheduleWarmup, stopWarmup } = warmup
  const hotkeys = createVoiceHotkeys({
    handleTapEvent,
    onModel: warmup.updateModel,
    onDisabled: () => {
      if (phase !== 'idle' || turnAction !== null) void onCancel()
    },
    onStopped: scheduleWarmup,
    onUnavailable: stopWarmup,
    onReady: () => {
      host.prewarm()
      scheduleWarmup()
    }
  })

  function publish(event: Partial<VoiceEvent> & { phase: VoicePhase }): void {
    const payload: VoiceEvent = {
      phase: event.phase,
      level: event.level ?? level,
      text: event.text,
      error: event.error,
      code: event.code
    }
    host.emit(CH.voice.event, payload)
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
      const mine = turn
      listeningWatchdog = setInterval(() => {
        if (mine !== turn || phase !== 'listening') {
          if (listeningWatchdog) clearInterval(listeningWatchdog)
          listeningWatchdog = null
          return
        }
        if (Date.now() - startedAt < getSettings().voice.maxDurationMs) return
        abortTurnWithError('Запись остановлена: слишком долго.', 'recordTooLong')
      }, WATCHDOG_MS)
      return
    }

    // `transcribing` has two halves with very different budgets: the hand-over
    // from the renderer (local work, milliseconds) and whisper itself (seconds on
    // a long phrase). `busy` says which half this is — it is set the moment the
    // recording arrives, and this function runs again at that point.
    const mine = turn
    const limit = busy ? transcribeBudgetMs : RECORDING_TIMEOUT_MS
    recordingTimer = setTimeout(() => {
      if (mine !== turn) return
      abortTurnWithError(
        busy ? 'Распознавание не ответило — попробуй ещё раз.' : 'Запись не дошла до распознавания — попробуй ещё раз.',
        busy ? 'transcribeFailed' : 'recordFailed'
      )
    }, limit)
  }

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
    if (phase === 'listening') host.emit(CH.voice.stop, { transcribe: false })
    abortRecognition()
  }

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

  /** False when the user tapped the key instead of holding it. */
  function longEnough(): boolean {
    return Date.now() - startedAt >= getSettings().voice.minDurationMs
  }

  /** Dispatches one tap edge; `ready`/`reenabled` need nothing from the controller. */
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
    if (phase === 'listening') return
    if (phase === 'transcribing') {
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
        if (host.isOpen() || phase !== 'listening' || mine !== turn) return
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
    if (mine !== turn || phase === 'idle') return
    host.showIndicator()
  }

  /**
   * Ends the turn, if the edge belongs to the hold that started it.
   *
   * An omitted binding means "the turn that is running", which is what the
   * programmatic `release()` helper means. The tap always names its hold.
   */
  async function onRelease(binding?: VoiceBinding): Promise<void> {
    if (phase !== 'listening') return
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
    if (phase === 'idle' && turnAction === null) return
    // The cancel must come from the hold that owns the card, or a stray edge of
    // the other one would abort a turn it never started.
    if (binding && binding !== turnBinding) return
    discardTurn()
    finishIdle({ error: hotkeys.listenerError() ?? undefined })
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
    if (phase !== 'transcribing') {
      return { ok: false, text: '', ms: 0, message: 'Пропущено.' }
    }
    const mine = turn

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
    transcribeBudgetMs = transcribeBudget(result.durationMs)
    // This turn is about to load the model itself; a warm-up would be a second
    // copy of the same work. Cancel first: stopping drops the mark of the load it
    // interrupts, and this turn takes over from there.
    stopWarmup()
    const model = getSettings().voice.model
    const controller = new AbortController()
    abort = controller
    // `busy` is set first: `setPhase` arms the watchdog, and which budget applies
    // (`RECORDING_TIMEOUT_MS` vs `TRANSCRIBE_TIMEOUT_MS`) is exactly what `busy`
    // distinguishes.
    setPhase('transcribing')
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
      if (mine !== turn) {
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
      if (mine === turn) finishIdle({ error: message, code: 'transcribeFailed' })
      return { ok: false, text: '', ms: 0, message }
    } finally {
      busy = false
      if (abort === controller) abort = null
    }
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

  /** Reports a recorder failure (no microphone, permission denied). */
  function failed(message: string): void {
    busy = false
    finishIdle({ error: message, code: 'noMic' })
  }

  /** Loudness tick from the renderer, forwarded as-is into the overlay event. */
  function setLevel(value: number): void {
    if (phase !== 'listening') return
    level = Math.max(0, Math.min(1, value))
    host.fieldLevel(level)
  }

  function stop(): void {
    // App shutdown or a full voice stop can land mid-hold; the surface must not
    // outlive the controller's state.
    if (turnAction === 'dictate') {
      host.endDictation(turnBinding === 'primary')
    }
    hotkeys.stop()
    abort?.abort()
    abort = null
    if (poller) clearInterval(poller)
    poller = null
    if (listeningWatchdog) clearInterval(listeningWatchdog)
    if (recordingTimer) clearTimeout(recordingTimer)
    listeningWatchdog = null
    recordingTimer = null
    warmup.reset()
    phase = 'idle'
    busy = false
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
    return busy || phase !== 'idle'
  }

  /**
   * What a freshly mounted card should do.
   *
   * Push-to-talk opens the window on the key press, so the renderer mounts after
   * the `record` broadcast has already gone out. Without this the very first turn
   * of every session would silently not record.
   */
  function attach(): { phase: VoicePhase; maxDurationMs: number } {
    return { phase, maxDurationMs: getSettings().voice.maxDurationMs }
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
    setLevel,
    mode,
    isBusy,
    attach,
    press,
    release,
    cancel,
    /** Exists for tests: the renderer learns the phase from `attach()` and the events. */
    phase: (): VoicePhase => phase
  }
}

export type VoiceController = ReturnType<typeof createVoiceController>
