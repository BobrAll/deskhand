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
import type {
  TranscribeResult,
  VoiceAction,
  VoiceErrorCode,
  VoiceEvent,
  VoicePhase
} from '@shared/types'
import { pasteAnswer } from '../paste'
import { helperBinary } from '../native/helper'
import { getSettings } from '../settings/store'
import { VoiceKeyListener, type TapEvent } from './listen'
import { cancelWarmRecognizer, transcribe, voiceStatus, warmRecognizer } from './recognizer'

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
  /** Puts recognised text into an open card. */
  deliver(text: string, options: DeliverOptions): void
  /**
   * Ends a dictation hold and puts the screen back the way it was.
   *
   * Hides the non-activating bars, or closes a card that owned the keyboard
   * when the hold began so focus returns to the app the card belongs to.
   */
  endDictation(): void
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
 * Ceiling for one recognition. The WAV is local and whisper runs on this machine,
 * so this only fires when the child process hangs or never reports back — a few
 * minutes of audio still takes seconds, not tens of seconds.
 */
const TRANSCRIBE_TIMEOUT_MS = 30_000
/**
 * How long after the tap comes up the recognizer is loaded in the background.
 *
 * Long enough that the launch itself — the card, the tray, the first paint — is
 * never competing with a 175 MB model for disk and CPU; short enough that a user
 * who reaches for the hotkey right after opening the app still finds it warm.
 * A press before this fires cancels the warm-up, because the phrase itself is
 * about to do the same work.
 */
const WARMUP_DELAY_MS = 3_000
/** A short tap ends without a recognition; try warming again after it. */
const WARMUP_RETRY_MS = 1_500

/** Which physical hold started the turn: the main hotkey or the dictation one. */
type VoiceBinding = 'primary' | 'dictation'

export function createVoiceController(host: VoiceHost) {
  let listeners: Record<VoiceBinding, VoiceKeyListener | null> = {
    primary: null,
    dictation: null
  }
  /** Kept so a `cancel` after a failed start can still explain itself. */
  const listenerErrors: Record<VoiceBinding, string | null> = {
    primary: null,
    dictation: null
  }
  let phase: VoicePhase = 'idle'
  let startedAt = 0
  let level = 0
  let poller: NodeJS.Timeout | null = null
  let abort: AbortController | null = null
  /** Set while a transcript is in flight. */
  let busy = false
  /**
   * What the turn in flight does with its transcript.
   *
   * Read at press time rather than at delivery time: the dictation hotkey means
   * "always type here", while the main one follows whatever `action` says.
   */
  let turnAction: VoiceAction | null = null
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
  /** Waiting warm-up, if any. */
  let warmTimer: NodeJS.Timeout | null = null
  /** The model `warmTimer` belongs to, so a model change can replace it. */
  let warmTimerFor: string | null = null
  /**
   * The model whose warm-up is running right now, if any.
   *
   * Kept apart from `warmedModel` because a load that is interrupted proves
   * nothing: cancelling it has to forget the mark it was going to earn.
   */
  let warmingModel: string | null = null
  /**
   * The model the recognizer has been loaded for.
   *
   * Set only after a warm-up reports that it really loaded the model, and when a
   * real recognition starts: either one has paid for the cold model. Cleared
   * when a warm-up is cancelled, when the selected model changes and on
   * `stop()`, so the next idle moment warms whatever is in force then.
   */
  let warmedModel: string | null = null

  function clearWarmTimer(): void {
    if (warmTimer) clearTimeout(warmTimer)
    warmTimer = null
    warmTimerFor = null
  }

  /**
   * Loads the recognizer in the background, once per model.
   *
   * Recognition starts only after the key is released, so the first phrase of a
   * session used to pay the whole cold start — process, model, compute backend —
   * after the user had already stopped talking. This moves that work to the idle
   * moment after launch instead; a press cancels it (see `onPress`) so the two
   * never run at once.
   */
  function scheduleWarmup(delayMs = WARMUP_DELAY_MS): void {
    const voice = getSettings().voice
    if (!voice.enabled) {
      stopWarmup()
      warmedModel = null
      return
    }
    if (warmedModel === voice.model || warmingModel === voice.model) return
    if (warmTimer && warmTimerFor === voice.model) return
    clearWarmTimer()
    warmTimerFor = voice.model
    warmTimer = setTimeout(() => {
      warmTimer = null
      warmTimerFor = null
      void warmNow()
    }, delayMs)
  }

  /**
   * Runs one warm-up, and remembers it only when it really loaded the model.
   *
   * `warmRecognizer` answers whether the recognizer actually ran. Marking the
   * model before that answer was what made one cancelled warm-up poison every
   * later one: the flag said "warm" while nothing had been loaded.
   */
  async function warmNow(): Promise<void> {
    const model = getSettings().voice.model
    // A phrase that is already running is doing the same work and owns the
    // machine: warm the next time the controller is idle.
    if (!warmAvailable()) return
    // Publish the load before the status check, so a press or a settings change
    // that lands during that await can invalidate this attempt and no second
    // warm-up is queued for the same model in the meantime.
    warmingModel = model
    try {
      // A missing binary or model has nothing to load; the settings window
      // already explains it, so a background attempt would only fail silently.
      const status = await voiceStatus().catch(() => null)
      if (warmingModel !== model || !status?.ready || !warmAvailable() ||
        getSettings().voice.model !== model) return
      const loaded = await warmRecognizer()
      if (loaded && getSettings().voice.model === model) warmedModel = model
    } finally {
      if (warmingModel === model) warmingModel = null
    }
  }

  /** Whether a background warm-up may run right now. */
  function warmAvailable(): boolean {
    const voice = getSettings().voice
    return voice.enabled && phase === 'idle' && !busy
  }

  /**
   * Stops the warm-up before a phrase uses the same model and CPU.
   *
   * The interrupted load never proved the model is warm, so its mark is dropped:
   * the next idle moment is free to try again.
   */
  function stopWarmup(): void {
    clearWarmTimer()
    cancelWarmRecognizer()
    if (warmingModel === null) return
    if (warmedModel === warmingModel) warmedModel = null
    warmingModel = null
  }

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

  function setPhase(
    next: VoicePhase,
    extra?: { text?: string; error?: string; code?: VoiceErrorCode }
  ): void {
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
    const limit = busy ? TRANSCRIBE_TIMEOUT_MS : RECORDING_TIMEOUT_MS
    recordingTimer = setTimeout(() => {
      if (mine !== turn) return
      abortTurnWithError(
        busy
          ? 'Распознавание не ответило — попробуй ещё раз.'
          : 'Запись не дошла до распознавания — попробуй ещё раз.',
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
    turn += 1
    if (phase === 'listening') host.emit(CH.voice.stop, { transcribe: false })
    abort?.abort()
    abort = null
    busy = false
    console.warn('[voice]', message)
    finishIdle({ error: message, code })
  }

  /**
   * Drops the turn in flight because the user has started a new one.
   *
   * Aborting is not enough on its own — recognition is a child process that can
   * still answer — so the press that follows bumps `turn` too, and the late
   * result is discarded because its turn is no longer the current one.
   */
  function supersede(): void {
    abort?.abort()
    abort = null
    busy = false
  }

  /** Ends the turn: one event carries both the new phase and its explanation. */
  function finishIdle(payload: { text?: string; error?: string; code?: VoiceErrorCode }): void {
    const action = turnAction ?? getSettings().voice.action
    turnAction = null
    host.setVoice(false)
    // Dictation never leaves anything on screen: the words went into the user's
    // own app, so a card would have nothing to show and would sit there as an
    // empty rectangle. This also covers the failed turns — a press that heard
    // nothing has no message worth a panel in the middle of the sentence.
    if (action === 'dictate') host.endDictation()
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
    if (event === 'release') {
      void onRelease()
      return
    }
    void onCancel()
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
      supersede()
      // A superseded dictation still owns the non-activating surface. The new
      // turn has to be free to open the card or show its own bars, so the old
      // hold ends here rather than at a `finishIdle` that will never run.
      if (turnAction === 'dictate') host.endDictation()
    }
    turnAction = binding === 'dictation' ? 'dictate' : getSettings().voice.action
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
      void host.open().then(() => {
        // The card refused to open (the app is on the exclusion list, or the
        // context is unusable). Recording into a card that will never exist
        // would leave the microphone open with nowhere to put the words.
        if (host.isOpen() || phase !== 'listening' || mine !== turn) return
        host.emit(CH.voice.stop, { transcribe: false })
        finishIdle({})
      })
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

  async function onRelease(): Promise<void> {
    if (phase !== 'listening') return
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

  async function onCancel(): Promise<void> {
    // Escape while talking, or the tap was disabled by macOS.
    if (phase === 'listening') host.emit(CH.voice.stop, { transcribe: false })
    abort?.abort()
    abort = null
    busy = false
    finishIdle({ error: listenerError() ?? undefined })
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
      busy = false
      finishIdle({ error: 'Запись не удалась — микрофон недоступен.', code: 'noMic' })
      return { ok: false, text: '', ms: 0, message: 'Запись не удалась.' }
    }
    if (!result.wavBase64) {
      // The recorder ran but found no speech: silence, or a press too short to be
      // a phrase. An error message would be wrong — nothing failed.
      busy = false
      finishIdle({ error: 'Ничего не расслышал — попробуй ещё раз.', code: 'notHeard' })
      return { ok: false, text: '', ms: 0, message: 'Речь не распознана.' }
    }

    busy = true
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
      if (transcribed.spawned === true && getSettings().voice.model === model) warmedModel = model
      // One line per turn: enough to diagnose a complaint, never the transcript
      // itself — what the user said is not log material. Audio length separates
      // "the model was slow" from "the phrase was long".
      console.log(`[voice] ${transcribed.ok ? 'ok' : 'failed'} in ${transcribed.ms} мс, ` +
        `${Math.round(result.durationMs)} мс аудио, модель ${model}`)
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
  }

  function ensureListener(binding: VoiceBinding, binary: string): VoiceKeyListener {
    const existing = listeners[binding]
    if (existing) return existing
    const created = new VoiceKeyListener({
      binary,
      swallow: true,
      onEvent: (event) => handleTapEvent(event, binding),
      onError: (message) => {
        listenerErrors[binding] = message
        console.warn('[voice]', message)
      }
    })
    listeners[binding] = created
    return created
  }

  function listenerError(): string | null {
    return listenerErrors.primary ?? listenerErrors.dictation
  }

  /** (Re)starts both taps from the current settings. Safe to call repeatedly. */
  function applySettings(): void {
    const settings = getSettings()
    const binary = helperBinary()
    if (!binary) {
      listenerErrors.primary = 'Нативный helper не найден — голосовой ввод недоступен.'
      listenerErrors.dictation = null
      return
    }
    const primary = ensureListener('primary', binary)
    const dictation = ensureListener('dictation', binary)
    // A different model has to be loaded again, and a warm-up for the old one is
    // now wasted work.
    if (warmingModel !== null && warmingModel !== settings.voice.model) stopWarmup()
    if (warmedModel !== null && warmedModel !== settings.voice.model) warmedModel = null
    if (!settings.voice.enabled) {
      primary.stop()
      dictation.stop()
      listenerErrors.primary = null
      listenerErrors.dictation = null
      scheduleWarmup()
      return
    }
    const primaryError = primary.start(settings.voice.hotkey)
    listenerErrors.primary = primaryError
    // Two taps on one combination would answer the same press twice. The main
    // hotkey owns it; the dictation one is simply left stopped.
    const shared = settings.voice.dictationHotkey === settings.voice.hotkey
    if (shared) dictation.stop()
    const dictationError = shared ? null : dictation.start(settings.voice.dictationHotkey)
    listenerErrors.dictation = dictationError
    if (primaryError && (shared || dictationError)) {
      // Neither hold can start a turn, so loading the model would only take the
      // machine for a feature that cannot be used.
      stopWarmup()
      return
    }
    // A tap is up and the feature is on: warm the renderer now, not on the first
    // key press. This covers a voice mode that was enabled in the settings window
    // during this run as well as the startup path — a window created by the first
    // press would lose that turn's animation and transcript.
    host.prewarm()
    scheduleWarmup()
  }

  function stop(): void {
    listeners.primary?.stop()
    listeners.dictation?.stop()
    listeners = { primary: null, dictation: null }
    abort?.abort()
    abort = null
    if (poller) clearInterval(poller)
    poller = null
    if (listeningWatchdog) clearInterval(listeningWatchdog)
    if (recordingTimer) clearTimeout(recordingTimer)
    listeningWatchdog = null
    recordingTimer = null
    stopWarmup()
    warmedModel = null
    phase = 'idle'
    busy = false
    turnAction = null
  }

  /**
   * Takes the taps down without forgetting the turn.
   *
   * The settings window arms a recorder to learn a new combination; while it is
   * armed the tap would swallow the very keys being typed. `applySettings`
   * brings it back with whatever is stored by then.
   */
  function suspend(): void {
    listeners.primary?.stop()
    listeners.dictation?.stop()
  }

  async function status() {
    const base = await voiceStatus()
    return { ...base, listenerError: listenerError() }
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
   * superseding and the transcript routing apply unchanged.
   */
  function press(binding: VoiceBinding = 'primary'): void {
    void onPress(binding)
  }

  function release(): void {
    void onRelease()
  }

  function cancel(): void {
    void onCancel()
  }

  return {
    applySettings,
    stop,
    suspend,
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
