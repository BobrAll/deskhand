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
import type { TranscribeResult, VoiceEvent, VoicePhase } from '@shared/types'
import { pasteAnswer } from '../paste'
import { helperBinary } from '../native/helper'
import { getSettings } from '../settings/store'
import { VoiceKeyListener, type TapEvent } from './listen'
import { transcribe, voiceStatus } from './whisper'

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
  /** Reveals the bars without activating the card or collecting context again. */
  showIndicator(): void
  /** Puts recognised text into an open card, sending it when `send` is true. */
  deliver(text: string, send: boolean): void
  /** Closes the card — dictation needs the user's own app in front. */
  hide(): void
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

export function createVoiceController(host: VoiceHost) {
  let listener: VoiceKeyListener | null = null
  let phase: VoicePhase = 'idle'
  let startedAt = 0
  let level = 0
  let poller: NodeJS.Timeout | null = null
  let abort: AbortController | null = null
  /** Set while a transcript is in flight. */
  let busy = false
  /** Kept so a `cancel` after a failed start can still explain itself. */
  let listenerError: string | null = null
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

  function publish(event: Partial<VoiceEvent> & { phase: VoicePhase }): void {
    const payload: VoiceEvent = {
      phase: event.phase,
      level: event.level ?? level,
      text: event.text,
      error: event.error
    }
    host.emit(CH.voice.event, payload)
  }

  function setPhase(next: VoicePhase, extra?: { text?: string; error?: string }): void {
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
        endStuckTurn('Запись остановлена: слишком долго.')
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
      endStuckTurn(
        busy
          ? 'Распознавание не ответило — попробуйте ещё раз.'
          : 'Запись не дошла до распознавания — попробуйте ещё раз.'
      )
    }, limit)
  }

  /** Closes a turn nobody is driving any more, and says why on the card. */
  function endStuckTurn(message: string): void {
    turn += 1
    if (phase === 'listening') host.emit(CH.voice.stop, { transcribe: false })
    abort?.abort()
    abort = null
    busy = false
    console.warn('[voice]', message)
    finishIdle({ error: message })
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
  function finishIdle(payload: { text?: string; error?: string }): void {
    host.setVoice(false)
    // Dictation never leaves anything on screen: the words went into the user's
    // own app, so a card would have nothing to show and would sit there as an
    // empty rectangle. This also covers the failed turns — a press that heard
    // nothing has no message worth a panel in the middle of the sentence.
    if (getSettings().voice.action === 'dictate') host.hide()
    setPhase('idle', payload)
  }

  /** False when the user tapped the key instead of holding it. */
  function longEnough(): boolean {
    return Date.now() - startedAt >= getSettings().voice.minDurationMs
  }

  /** Dispatches one tap edge; `ready`/`reenabled` need nothing from the controller. */
  function handleTapEvent(event: TapEvent): void {
    if (event === 'ready' || event === 'reenabled') return
    if (event === 'press') {
      void onPress()
      return
    }
    if (event === 'release') {
      void onRelease()
      return
    }
    void onCancel()
  }

  async function onPress(): Promise<void> {
    if (!getSettings().voice.enabled) return
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
    }
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
    host.emit(CH.voice.record, { maxDurationMs: getSettings().voice.maxDurationMs })
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
    finishIdle({ error: listenerError ?? undefined })
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
      finishIdle({ error: 'Запись не удалась — микрофон недоступен.' })
      return { ok: false, text: '', ms: 0, message: 'Запись не удалась.' }
    }
    if (!result.wavBase64) {
      // The recorder ran but found no speech: silence, or a press too short to be
      // a phrase. An error message would be wrong — nothing failed.
      busy = false
      finishIdle({ error: 'Ничего не расслышал — попробуйте ещё раз.' })
      return { ok: false, text: '', ms: 0, message: 'Речь не распознана.' }
    }

    busy = true
    const controller = new AbortController()
    abort = controller
    // `busy` is set first: `setPhase` arms the watchdog, and which budget applies
    // (`RECORDING_TIMEOUT_MS` vs `TRANSCRIBE_TIMEOUT_MS`) is exactly what `busy`
    // distinguishes.
    setPhase('transcribing')
    try {
      const wav = Buffer.from(result.wavBase64, 'base64')
      const transcribed = await transcribe({ wav, signal: controller.signal })
      // One line per turn: enough to diagnose a complaint, never the transcript
      // itself — what the user said is not log material.
      console.log(`[voice] ${transcribed.ok ? 'ok' : 'failed'} in ${transcribed.ms} мс`)
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
        finishIdle({ error: transcribed.message })
        return transcribed
      }
      applyTranscript(transcribed.text)
      finishIdle({ text: transcribed.text })
      return transcribed
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Распознавание не удалось.'
      if (mine === turn) finishIdle({ error: message })
      return { ok: false, text: '', ms: 0, message }
    } finally {
      busy = false
      if (abort === controller) abort = null
    }
  }

  /** Routes the transcript according to the configured action. */
  function applyTranscript(text: string): void {
    const settings = getSettings()
    if (settings.voice.action === 'dictate') {
      // Dictation replaces the assistant card: the words belong in the app the
      // user was working in, so the card gets out of the way and types there.
      const target = host.target()
      host.hide()
      void pasteAnswer(text, target)
      return
    }
    host.deliver(text, settings.voice.autoSend)
  }

  /** Reports a recorder failure (no microphone, permission denied). */
  function failed(message: string): void {
    busy = false
    finishIdle({ error: message })
  }

  /** Loudness tick from the renderer, forwarded as-is into the overlay event. */
  function setLevel(value: number): void {
    if (phase !== 'listening') return
    level = Math.max(0, Math.min(1, value))
  }

  /** (Re)starts the tap from the current settings. Safe to call repeatedly. */
  function applySettings(): void {
    const settings = getSettings()
    const binary = helperBinary()
    if (!binary) {
      listenerError = 'Нативный helper не найден — голосовой ввод недоступен.'
      return
    }
    if (!listener) {
      listener = new VoiceKeyListener({
        binary,
        swallow: true,
        onEvent: (event) => {
          handleTapEvent(event)
        },
        onError: (message) => {
          listenerError = message
          console.warn('[voice]', message)
        }
      })
    }
    if (!settings.voice.enabled) {
      listener.stop()
      listenerError = null
      return
    }
    const error = listener.start(settings.voice.hotkey)
    listenerError = error ?? null
    // The tap is up and the feature is on: warm the renderer now, not on the
    // first key press. This covers a voice mode that was enabled in the settings
    // window during this run as well as the startup path — a window created by
    // the first press would lose that turn's animation and transcript.
    if (!error) host.prewarm()
  }

  function stop(): void {
    listener?.stop()
    listener = null
    abort?.abort()
    abort = null
    if (poller) clearInterval(poller)
    poller = null
    if (listeningWatchdog) clearInterval(listeningWatchdog)
    if (recordingTimer) clearTimeout(recordingTimer)
    listeningWatchdog = null
    recordingTimer = null
    phase = 'idle'
    busy = false
  }

  /**
   * Takes the tap down without forgetting the turn.
   *
   * The settings window arms a recorder to learn a new combination; while it is
   * armed the tap would swallow the very keys being typed. `applySettings`
   * brings it back with whatever is stored by then.
   */
  function suspend(): void {
    listener?.stop()
  }

  async function status() {
    const base = await voiceStatus()
    return { ...base, listenerError }
  }

  /** Settings the overlay needs: whether to offer the hold-to-talk hint at all. */
  function mode(): { enabled: boolean; action: 'command' | 'dictate'; hotkey: string } {
    const settings = getSettings()
    return {
      enabled: settings.voice.enabled,
      action: settings.voice.action,
      hotkey: settings.voice.hotkey
    }
  }

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
  function press(): void {
    void onPress()
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
    phase: (): VoicePhase => phase
  }
}

export type VoiceController = ReturnType<typeof createVoiceController>
