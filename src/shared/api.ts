/**
 * The `window.deskhand` bridge contract. Implemented by the preload script and
 * consumed by the renderer bundles. Types only — no runtime imports.
 */
import type {
  AgentAvailability,
  AgentCursorFrame,
  AgentEvent,
  AgentPointerFrame,
  AnnotationsEvent,
  AppSettings,
  ContextFlags,
  ContextSnapshot,
  DownloadProgress,
  KeyStatus,
  OverlayState,
  PasteResult,
  PermissionState,
  PointerPayload,
  ProviderId,
  SendRequest,
  StreamEvent,
  TestKeyResult,
  TranscribeResult,
  TtsStatus,
  VoiceEvent,
  VoicePhase,
  VoiceStatus
} from './types'
import type { TtsResult } from './tts'

/**
 * One application, named the way settings store it: `bundleId` is the value that
 * goes into `excludedApps`, `name` is what the user reads.
 */
export interface AppInfo {
  bundleId: string
  name: string
}

/** An app that is running right now, offered in the excluded-apps list. */
export type RunningAppInfo = AppInfo

/** The app the `.app` picker returned; it may name one that is not running. */
export type AppPickResult = AppInfo

export interface SettingsBundle {
  settings: AppSettings
  keys: KeyStatus[]
  permissions: PermissionState
  encryptionAvailable: boolean
  /**
   * Set only by `settings.save` when the requested hotkey could not be
   * registered and the previous binding was put back. The window uses it to drag
   * the draft back to the stored combination instead of retrying a write the
   * system refuses. Absent everywhere else — `settings.load` never sets it.
   */
  hotkeyError?: boolean
}

export interface ActionResult {
  ok: boolean
  message?: string
}

/** Unsubscribe callback returned by every event subscription. */
export type Unsubscribe = () => void

export interface DeskhandApi {
  overlay: {
    getState(): Promise<OverlayState | null>
    onState(handler: (state: OverlayState) => void): Unsubscribe
    /**
     * The card is on screen but has no session yet.
     *
     * The window is a long-lived page that still holds the previous turn, and it
     * now appears before the context is collected. This says "forget what you were
     * showing": without it a reopened card displays the old answer for the few
     * hundred milliseconds a selection read takes, and the user reads that as an
     * answer to a question they have not asked.
     */
    onPreparing(handler: () => void): Unsubscribe
    onContextUpdate(handler: (snapshot: ContextSnapshot) => void): Unsubscribe
    onStream(handler: (event: StreamEvent) => void): Unsubscribe
    /** Fires when shapes appear or disappear on the screen. */
    onAnnotations(handler: (event: AnnotationsEvent) => void): Unsubscribe
    setFlags(flags: ContextFlags): void
    send(request: SendRequest): void
    cancel(requestId: string): void
    copy(text: string): Promise<ActionResult>
    paste(text: string): Promise<PasteResult>
    /** Removes the drawings without closing the card. */
    clearPointer(): void
    /**
     * The user started writing in the field.
     *
     * A card that has stepped aside for a drawing comes back to its normal
     * density as soon as it is being typed into: at that point the user is
     * reading the card, not the screen behind it. The main process restores the
     * window's own blur on the same signal.
     */
    setTyping(typing: boolean): void
    close(): void
    /**
     * Reports the laid-out card. The width is optional because the folded card
     * is narrower than the one that shows an answer; omitting it keeps the full
     * width.
     *
     * `pin` keeps the card's left edge and lets the far edge move, which is what
     * dragging the right edge means: the edge under the pointer has to follow the
     * pointer, and the anchor would otherwise decide which side grows.
     */
    resize(height: number, width?: number, pin?: boolean): void
  }
  /** Used only by the transparent drawing layer. */
  pointer: {
    onDraw(handler: (payload: PointerPayload) => void): Unsubscribe
  }
  /**
   * Used by the agent's display layer for its edge glow and status caption.
   * Like the drawing layer, it renders what it is given and never sends input.
   */
  agentCursor: {
    onState(handler: (frame: AgentCursorFrame) => void): Unsubscribe
  }
  /**
   * The virtual pointer that shows where the agent is about to act.
   *
   * Same contract as the drawing layer: it receives geometry and paints it. It
   * cannot press anything, and the action itself has already been decided.
   */
  agentPresenter: {
    onState(handler: (frame: AgentPointerFrame) => void): Unsubscribe
  }
  settings: {
    load(): Promise<SettingsBundle>
    save(settings: AppSettings): Promise<SettingsBundle>
    setKey(provider: ProviderId, key: string): Promise<SettingsBundle>
    deleteKey(provider: ProviderId): Promise<SettingsBundle>
    /** `baseUrl` lets the form verify an override before it is saved. */
    testKey(provider: ProviderId, key: string, baseUrl?: string): Promise<TestKeyResult>
    runningApps(): Promise<RunningAppInfo[]>
    pickApp(): Promise<AppPickResult | null>
    open(): void
    close(): void
    /**
     * Tells the main process whether edits are still being written.
     *
     * The window saves as it is edited, so `close()` can arrive mid-write. While
     * the hold is `true` the main process waits a moment before destroying the
     * window instead of discarding the last keystroke.
     */
    hold(held: boolean): void
    /**
     * Tells the main process that a hotkey recorder is armed.
     *
     * While it is `true` the app's own global listeners are unregistered: the
     * old binding would otherwise swallow the combination being typed, and the
     * voice tap would start recording instead of letting the key through.
     */
    recording(active: boolean): void
  }
  onboarding: {
    complete(): Promise<void>
    openSettings(): void
  }
  permissions: {
    status(): Promise<PermissionState>
    request(): Promise<PermissionState>
    open(kind: 'accessibility' | 'screenRecording' | 'microphone'): void
    requestMicrophone(): Promise<boolean>
  }
  /**
   * Agent mode. The card renders what the main process reports and can stop it;
   * it never posts an event of its own — every cursor movement comes from the
   * native helper, so a compromised page cannot drive the machine.
   */
  agent: {
    onEvent(handler: (event: AgentEvent) => void): Unsubscribe
    /** Whether pressing and typing is possible right now, and why not. */
    availability(): Promise<AgentAvailability>
    /**
     * Persists the master switch and resolves with the new state.
     *
     * The reason to have this at all: the moment a user finds out the mode is off
     * is the moment they asked for an action and got a drawing instead, and making
     * them find the settings window and press "Сохранить" for one checkbox is how
     * the mode stays unused. It only flips the switch — it cannot start a plan or
     * move the cursor — and the settings tab goes through the same call so the two
     * windows can never disagree about whether the mode is on.
     */
    setEnabled(enabled: boolean): Promise<AgentAvailability>
    /** Stops the run in flight. Resolves once nothing is moving the cursor. */
    stop(): Promise<void>
    /**
     * Answers the confirmation the card is showing.
     *
     * `id` identifies the exact call that was asked about: an answer that arrives
     * after the run moved on is ignored rather than applied to the next question,
     * which is what makes a slow click harmless. `remember` persists the decision
     * for that one fingerprint and nothing broader.
     */
    answer(id: string, allow: boolean, remember: boolean): Promise<void>
    /** Forgets every "разрешить всегда", so the questions come back. */
    clearApprovals(): Promise<void>
  }
  /**
   * Push-to-talk. The main process owns the keyboard and the whisper process; the
   * overlay only records, because it is the window that has microphone access.
   */
  voice: {
    onEvent(handler: (event: VoiceEvent) => void): Unsubscribe
    /** Start capturing; `maxDurationMs` bounds a key that gets stuck. */
    onRecord(handler: (request: { maxDurationMs: number }) => void): Unsubscribe
    /** Stop capturing; `transcribe: false` throws the audio away (Escape). */
    onStop(handler: (request: { transcribe: boolean }) => void): Unsubscribe
    /**
     * Asks the main process what it is waiting for. The overlay is opened by the
     * key press itself, so it can mount *after* the "start recording" broadcast.
     */
    attach(): Promise<{ phase: VoicePhase; maxDurationMs: number }>
    /** Reports the finished 16 kHz mono WAV; resolves with that turn's result. */
    recorded(wavBase64: string, durationMs: number): Promise<TranscribeResult>
    /**
     * Recognised speech, delivered to the card. `send` is true when the user wants
     * the transcript asked at once (`action: command` + `autoSend`).
     */
    onTranscript(handler: (payload: { text: string; send: boolean }) => void): Unsubscribe
    failed(message: string): void
    /** Loudness of the block just captured, 0..1, for the waveform. */
    level(level: number): void
    status(): Promise<VoiceStatus>
    /** Downloads one catalog model; progress arrives through `onDownloadProgress`. */
    download(model: string): Promise<VoiceStatus>
    onDownloadProgress(handler: (progress: DownloadProgress) => void): Unsubscribe
    importModel(): Promise<VoiceStatus | null>
    deleteModel(id: string): Promise<VoiceStatus>
    /** Records a short clip and transcribes it, so the user can hear the quality. */
    test(): Promise<TranscribeResult>
  }
  /**
   * The assistant's own voice.
   *
   * Separate from `voice`, which is the microphone. The card asks for a clip and
   * plays it; the main process owns the provider key and the disk cache, so a
   * repeated line is never paid for twice.
   */
  tts: {
    speak(text: string): Promise<TtsResult>
    status(): Promise<TtsStatus>
    /** Stores the key encrypted; an empty string removes it. */
    setKey(key: string): Promise<TtsStatus>
    deleteKey(): Promise<TtsStatus>
    /** Renders a short sample with the current settings, for listening in the pane. */
    preview(): Promise<TtsResult>
  }
}
