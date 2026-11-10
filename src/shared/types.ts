/**
 * Types shared between the main process, preload and renderer bundles.
 * Keep this module free of Node/Electron imports.
 */

export type ProviderId = 'openrouter' | 'openai' | 'anthropic'

/**
 * `insert` — plain text to paste into a field, `analyze` — markdown breakdown.
 *
 * There is deliberately no "guide" mode: drawing on the screen is a tool the
 * model invokes per answer (`@point` in the system prompt), not a mode the user
 * has to switch on beforehand.
 */
export type ResponseMode = 'insert' | 'analyze'

/** What a finished transcript does: ask the model, or type it into the app. */
type VoiceAction = 'command' | 'dictate'

/** Hold-to-talk input: a local whisper model turns speech into text. */
export interface VoiceSettings {
  enabled: boolean
  /** Accelerator held down to talk, e.g. "Alt+Shift+Space". */
  hotkey: string
  /** Id from `VOICE_MODELS`; the file itself lives in the models directory. */
  model: string
  /** Whisper language code, or `auto` to let the model detect it. */
  language: string
  /** `command` sends the transcript to the model, `dictate` types it into the app. */
  action: VoiceAction
  /** `command` only: send the recognised wording at once instead of filling the field. */
  autoSend: boolean
  /**
   * What speaks the answer itself, as opposed to the short recorded lines.
   *
   * `off` — the answer is read, not heard; the card is the channel.
   * `system` — the macOS voice, free and local, but it reads like a log.
   * `neural` — the voice configured in `tts`, which costs a request per answer
   * and needs a key. Falls back to `system` when it is not configured.
   */
  answerVoice: AnswerVoice
  /** Short acknowledgement while an agent command is pending. */
  agentFeedback: boolean
  /** A shorter press is treated as an accidental tap and thrown away. */
  minDurationMs: number
  /** Hard cap so a stuck key cannot record forever. */
  maxDurationMs: number
}

export type AnswerVoice = 'off' | 'system' | 'neural'

/**
 * Live speech synthesis for lines that were not recorded in advance.
 *
 * The app ships with its short lines already rendered, so this is not needed for
 * the assistant to have a voice at all. It exists for two cases: reading an
 * answer aloud in the same voice, and re-recording a line in a different voice.
 *
 * Every field is the user's: the endpoint, the model, the voice and the delivery
 * instruction. Nothing here is baked into the build, and the key is not part of
 * this object at all — it lives encrypted in `secrets` and never reaches a
 * renderer.
 */
export interface TtsSettings {
  /** Off means "use the shipped recordings only". */
  enabled: boolean
  /** API root without a trailing slash, e.g. `https://host/v1`. */
  baseUrl: string
  model: string
  voice: string
  /** Free-form delivery instruction, sent as `instructions`. */
  style: string
}

/**
 * Agent mode: the assistant may take over the mouse and the keyboard.
 *
 * It is off by default and gated on three things at once — this switch, the
 * Accessibility permission (macOS only lets a trusted process post events into
 * another app) and the agent binary itself. Every one of them can be missing, so
 * "enabled" here means "may", not "will", and the card names whichever one is
 * actually blocking.
 *
 * The user keeps the last word in three ways, none of which is a setting: Escape,
 * a hand on the physical mouse, and the question the agent asks before anything
 * that commits — sending, paying, deleting, granting access.
 */
export interface AgentSettings {
  /** Fingerprints of actions the user allowed forever, from the card's button. */
  rememberedApprovals: string[]
  /** Master switch. Off unless the user turned it on in the settings. */
  enabled: boolean
  /**
   * How many model turns one task may take.
   *
   * The agent decides its next call from the previous result, so this is a
   * budget rather than a plan length: one turn can hold several calls, and a run
   * that reaches the ceiling stops with what it has instead of looping. The
   * ceiling is set by the user; only a floor of one is enforced.
   */
  maxSteps: number
  /** Moving the physical mouse takes control back immediately. */
  abortOnMouseMove: boolean
  /**
   * Check the accessibility tree once more after the last call of a batch.
   *
   * The model's "готово" is an opinion about a frame that no longer exists: the
   * agent has clicked and typed since the picture it reasoned about was taken.
   * With this on, the last call of each batch is followed by a diff of the tree,
   * and the model sees whether anything actually changed before it claims
   * success. Off, the agent takes its own word for it.
   */
  verifyResult: boolean
  /**
   * Show each action on screen: the target window comes forward and a pointer
   * travels to the element before it is pressed.
   *
   * Purely a presentation flag. The action runs through the same accessibility
   * and event APIs either way; with this off the agent is the same agent, only
   * unseen — which is what a future background mode will use. It is not a
   * per-app or per-tool switch, so nothing has to be taught about a new app.
   */
  showActions: boolean
}

/**
 * Lifecycle of one agent run, mirrored into the overlay.
 *
 * The card renders the phase, not a guess about it: `asking` is the run stopped
 * on a question, `acting` is a call in flight, and `done` is the agent's own
 * closing word rather than the host's optimism.
 */
export type AgentPhase =
  | 'idle'
  | 'arming'
  | 'acting'
  /**
   * The run is stopped in front of one call until the user allows or refuses it.
   *
   * Its own phase rather than a flag on `acting` because everything about the
   * card changes with it: it becomes clickable, it stops counting steps, and the
   * question is what it is showing.
   */
  | 'asking'
  | 'done'
  | 'aborted'
  | 'error'

/**
 * Whether agent mode can be used at all right now, and why not.
 *
 * The overlay shows this instead of guessing: "модель не может нажать" and
 * "модель не видит экран" are different problems with different fixes.
 */
export interface AgentAvailability {
  /** The user turned the mode on. */
  enabled: boolean
  /** A native helper exists and Accessibility is granted. */
  ready: boolean
  /** Human-readable reason when `ready` is false. */
  reason: string | null
}

/**
 * One thing the agent wants to do to the machine, as it asks for permission.
 *
 * The agent is the Swift process in `native/deskhand`; it asks before every
 * mutating tool call and waits for the answer. The card is where that question
 * is shown, because the question is about the window the user is looking at —
 * a modal sheet from the main process would cover the very element the agent
 * named, and a dialog that hides its own evidence is worse than no dialog.
 */
export interface AgentToolRequest {
  /** Matches the answer back to the question that is waiting for it. */
  id: string
  /** The tool's own name: `click`, `type_text`, `press_key`, `set_value`… */
  tool: string
  /** Raw tool arguments, so the card can name the target without guessing. */
  arguments: Record<string, unknown>
  /**
   * A stable fingerprint of what this call would do, computed by the agent.
   *
   * "Разрешить всегда" stores this, not the sentence around it: the same button
   * in the same app is the same decision, while the same word in another app is
   * a different one. Typed text is deliberately not part of it.
   */
  fingerprint: string
  app?: string
  bundleId?: string
  role?: string
  title?: string
  label?: string
  /** Typing into a field prepares text and commits nothing. */
  textField?: boolean
  /** What the model said it was doing, when it said anything. */
  narration?: string
}

/** What the run is doing, as the card shows it while it happens. */
export interface AgentEvent {
  phase: AgentPhase
  /** The whole task succeeded, rather than just one intermediate call. */
  completed?: boolean
  /** 1-based model turn, and the budget it is counted against. */
  step: number
  total: number
  /** What is happening, in the user's language ("Нажимаю «Экспорт»"). */
  label: string
  /**
   * Set while the run is waiting for the user to allow one call.
   *
   * Its presence is the whole state: the card renders the buttons from it and
   * lifts its click-through while it is there. It is cleared by the answer, so a
   * stale question can never outlive the run that asked it.
   */
  approval?: AgentToolRequest | null
  /**
   * What the agent has done so far, newest last.
   *
   * The plan is not known in advance any more — the agent decides its next call
   * after seeing the result of the previous one — so the card shows the log it
   * actually produced instead of a list it was handed at the start.
   */
  actions?: AgentActionRow[]
  /** Set on `error` / `aborted`: why the run stopped. */
  message?: string
}

/** One finished agent call, as the card lists it. */
export interface AgentActionRow {
  /** The tool the agent used, in its own words ("click", "type_text"). */
  tool: string
  /** What that meant for the user, in their language ("Клик по «Экспорт»"). */
  label: string
  /** `false` when the call failed and the agent had to change course. */
  ok: boolean
}

/**
 * How a run ended.
 *
 * The four cases the card has to tell apart are all here, and they are not
 * variations of each other: an answer (something happened and the agent can say
 * what), a stop (the user interrupted), a refusal (nothing was attempted) and a
 * failure (something went wrong). Collapsing them into "empty answer" is how a
 * blocked run used to look identical to a run that quietly did nothing.
 */
export interface AgentRunResult {
  /** The agent's final answer, in the user's language. */
  answer: string
  /** What actually happened, one row per call, for the card and the history. */
  actions: AgentActionRow[]
  /** Set when the run stopped early, or when it could not start. */
  message?: string
  /** The user pressed Escape, or took the mouse. */
  aborted?: boolean
  /** Nothing was attempted: the mode is off or a permission is missing. */
  blocked?: boolean
  /**
   * The run ended without finishing the task: it ran out of steps, or the loop
   * guard caught it repeating itself.
   *
   * Distinct from `blocked`, which means the run never started, and from
   * `aborted`, which means the user stopped it. This is the agent's own failure,
   * and the one case where an answer exists but the task does not — so the card
   * has to say so rather than show a checkmark over a task it did not finish.
   */
  incomplete?: boolean
}

/** State of the agent’s screen glow and its caption at the pointer. */
export interface AgentCursorFrame {
  /** `false` plays the fade-out; the window is hidden right after it. */
  visible: boolean
  /** Pointer position *inside* the layer, in points. */
  anchor: { x: number; y: number }
  /** Which side of the pointer the caption hangs on. */
  side: 'above' | 'below'
  /**
   * `arming` = about to start, `acting` = a step is running, `waiting` = the turn
   * is preparing actions or reading the screen, with no running step to count.
   */
  phase: 'arming' | 'acting' | 'waiting' | 'success'
  /** What is happening, in the user's language ("Клик: «Экспорт»"). */
  label: string
  /** 1-based index of the running step; 0 while arming. */
  step: number
  total: number
}

/**
 * What kind of gesture an action will look like.
 *
 * Mirrors the Swift `ActionPresentation.Gesture`. The layer uses it to choose
 * an animation, never to decide whether the action is allowed: the host has
 * already approved the call by the time this arrives.
 */
export type AgentGesture =
  | 'click'
  | 'secondary'
  | 'type'
  | 'value'
  | 'select'
  | 'key'
  | 'scroll'
  | 'drag'
  | 'activate'

/**
 * One action, in screen terms, as the agent reports it just before acting.
 *
 * This is a picture, not an instruction: coordinates are global screen points,
 * and every field except `tool` and `gesture` is optional because a valid
 * action can have no element to point at. The agent never waits for the layer
 * to draw this, which is what keeps the visualisation from costing time.
 */
export interface AgentPresentation {
  tool: string
  gesture: AgentGesture
  app?: string
  bundleId?: string
  pid?: number
  /** Where the action is aimed, in global screen points. */
  point?: { x: number; y: number }
  /** The element's frame in global screen points. */
  target?: ScreenRect
  /** The window the action belongs to, in global screen points. */
  window?: ScreenRect
}

/** One frame of the virtual pointer the agent's layer draws. */
export interface AgentPointerFrame {
  /** `false` plays the fade-out; the window is hidden right after it. */
  visible: boolean
  /** Where the pointer is going, inside the layer. */
  point: { x: number; y: number }
  /**
   * Where to start, when the layer was hidden or moved to another display.
   * Absent on a normal step: the pointer then travels from where it already is.
   */
  from?: { x: number; y: number }
  /**
   * True while the pointer only waits for the next action.
   *
   * The mark is on screen for the whole run, so most frames describe a pause
   * rather than a gesture. An idle frame must not ripple or press: nothing is
   * happening yet, and an animation would say otherwise.
   */
  idle?: boolean
  /** The gesture being shown. Absent while the pointer is idle. */
  gesture?: AgentGesture
  /** The element being acted on, inside the layer. */
  target?: ScreenRect
}

/** Lifecycle of one push-to-talk turn, mirrored into the overlay. */
export type VoicePhase = 'idle' | 'listening' | 'transcribing'

/** One turn of the voice pipeline: what the overlay needs to animate. */
export interface VoiceEvent {
  phase: VoicePhase
  /** 0..1 loudness of the last audio block; opens the bars on the chip. */
  level: number
  /** Set on `idle`: what happened, so the card can show it briefly. */
  text?: string
  /** Set on `idle` when the turn failed instead of producing text. */
  error?: string
}

export interface VoiceStatus {
  /** Everything needed for a turn is in place. */
  ready: boolean
  /**
   * Whether push-to-talk is switched on.
   *
   * `ready` only says the install is complete; a user who turned the feature off
   * still has the model and the binary. The overlay uses this to decide whether
   * opening the microphone ahead of a press is welcome at all.
   */
  enabled: boolean
  /** Human-readable reason when `ready` is false. */
  detail: string | null
  /** Model file that will actually be used, or null when none was found. */
  modelPath: string | null
  /** `whisper-cli` binary that will actually be used. */
  binaryPath: string | null
  /** Where models are downloaded to. */
  modelsDir: string
  /** Catalog IDs and imported model filenames stored in the app’s models directory. */
  installed: string[]
  /** Set when the keyboard listener could not be started. */
  listenerError: string | null
}

export interface DownloadProgress {
  model: string
  received: number
  total: number
  done: boolean
  error?: string
}

/**
 * Whether the assistant can speak a line that was not recorded in advance.
 *
 * `configured: false` is not a broken app: the shipped lines still play, and an
 * answer is read with the macOS voice or not at all, depending on
 * `voice.answerVoice`.
 */
export interface TtsStatus {
  /** Live synthesis is switched on and has everything it needs. */
  configured: boolean
  /** Why not, when `configured` is false. */
  reason: string | null
  /** The voice that will speak live lines, as configured. */
  voice: string
  model: string
  /** Whether an API key is stored for this endpoint. */
  keyConfigured: boolean
  /** The voice the shipped recordings were made with; always available. */
  recordedVoice: string
}


export interface TranscribeResult {
  ok: boolean
  text: string
  /** Wall-clock milliseconds spent in whisper, shown as "распознано за 0.9 с". */
  ms: number
  message?: string
}

export interface AppSettings {
  provider: ProviderId
  /** Per-provider model id. Empty string means "use provider default". */
  models: Record<ProviderId, string>
  /** Per-provider model override for background web search. */
  searchModels: Record<ProviderId, string>
  /**
   * Per-provider API base URL override (no trailing slash, no endpoint path).
   * Empty string means "use the provider default" — see `ProviderInfo.defaultBaseUrl`.
   */
  baseUrls: Record<ProviderId, string>
  /**
   * Per-provider JSON object merged into every model request body, as typed.
   * Lets a user pass what their gateway understands (e.g. a switch that turns
   * reasoning off) without the app knowing about that gateway. Empty = nothing.
   */
  extraBody: Record<ProviderId, string>
  temperature: number
  maxTokens: number
  systemPrompt: string
  /** Electron accelerator string, e.g. "Alt+Space". */
  hotkey: string
  captureScreenshotByDefault: boolean
  screenshotMaxSide: number
  screenshotQuality: number
  /** Bundle identifiers where Deskhand does nothing at all. */
  excludedApps: string[]
  rememberConversation: boolean
  launchAtLogin: boolean
  onboardingCompleted: boolean
  /** Push-to-talk voice input (local whisper). */
  voice: VoiceSettings
  /** Live synthesis for lines that were not recorded in advance. */
  tts: TtsSettings
  /** Mouse-and-keyboard control ("агент"). Off by default. */
  agent: AgentSettings
}

export interface ActiveAppInfo {
  bundleId: string
  name: string
  pid: number
  windowTitle: string | null
  windowId: number | null
  bounds: { x: number; y: number; width: number; height: number } | null
}

export interface SelectionInfo {
  text: string
  truncated: boolean
}

/** A rectangle in global screen points (top-left origin), as Electron reports it. */
export interface ScreenRect {
  x: number
  y: number
  width: number
  height: number
}

/** A point in normalised image coordinates: `0..1`, origin at the top-left. */
export interface Point01 {
  x: number
  y: number
}

/**
 * The shapes the assistant may draw over the screen. Everything is expressed in
 * normalised image coordinates, never in pixels — that is what keeps annotations
 * correct on Retina displays and after the screenshot was downscaled.
 */
export type AnnotationKind = 'circle' | 'box' | 'arrow' | 'underline'

export interface Annotation {
  kind: AnnotationKind
  /** Start point: the centre of a circle, one corner of a box, the arrow tail. */
  from: Point01
  /** End point: a point on the circle, the opposite corner, the arrow head. */
  to: Point01
  /** Short caption drawn next to the shape. */
  label?: string
}

/** An annotation that already has an id, so the renderer can animate it in once. */
export interface PointerShape extends Annotation {
  id: string
}

/** What the transparent drawing layer renders. */
export interface PointerPayload {
  /** Layer size in points; shapes are scaled to it, not to the capture. */
  width: number
  height: number
  /** Bumped whenever the layer is shown again, so animations replay. */
  revision: number
  /** `false` drives the fade-out before the window is hidden. */
  visible: boolean
  shapes: PointerShape[]
}

/**
 * One element as the Accessibility API describes it.
 *
 * This is the answer to "where is it, really". The model returns a point in the
 * picture and a language model's point is routinely twenty to sixty points off —
 * enough to hit the neighbour of a 24-point toolbar icon. macOS knows the actual
 * rectangle of every button, so the click is aimed at its centre instead of at
 * the model's guess, and the guess is only used to decide *which* rectangle.
 *
 * Frames are in global screen points with the top-left origin — the same space
 * as `ScreenshotInfo.area`, Electron's `screen` module and the helper's clicks.
 */
export interface AxElementInfo {
  role: string
  subrole?: string
  /** Visible text of the element (a button caption, a menu item's name). */
  title?: string
  /** Current value of a control; for text fields this is the text inside. */
  value?: string
  /** Accessibility label, which is how an icon-only button names itself. */
  description?: string
  /** Tooltip or help exposed by Accessibility. */
  help?: string
  /** Localised role name ("кнопка", "поле ввода") — for humans, not matching. */
  roleDescription?: string
  frame?: ScreenRect | null
  /** The element advertises `AXPress`: clicking it is what it is for. */
  pressable?: boolean
  /** A text input: clicking it focuses it, and typing then lands here. */
  editable?: boolean
  /** How deep the element was found; used only for diagnostics. */
  depth?: number
  /** Owning process, so an element of our own overlay can be ignored. */
  pid?: number
  actions?: string[]
}

/**
 * What the Accessibility API reported for one look at the screen.
 *
 * `chain` is the element under a concrete point and its ancestors (a static text
 * inside a button inside a toolbar), `targets` is the flat list of everything
 * actionable in the focused window and the menu bar, and `focused` is what has
 * the keyboard right now — the difference between "the click landed in the field"
 * and "the click landed next to it, and the text is about to go somewhere else".
 */
export interface AxProbe {
  pid: number
  app: string
  chain: AxElementInfo[]
  targets: AxElementInfo[]
  focused: AxElementInfo | null
  elapsedMs: number
}

export interface ScreenshotInfo {
  /** data:image/jpeg;base64,... — used for the preview and the request. */
  dataUrl: string
  width: number
  height: number
  bytes: number
  /** Epoch ms of the capture, so the overlay can show how old the image is. */
  capturedAt: number
  /**
   * The screen rectangle the image covers, in global points. Annotations are
   * normalised against the *image*, so mapping them back onto the screen is a
   * plain scale between this rectangle and `width`/`height`.
   */
  area: ScreenRect | null
  /** True when the image is of a whole display rather than of one window. */
  fullScreen: boolean
}

export interface ContextSnapshot {
  activeApp: ActiveAppInfo | null
  selection: SelectionInfo | null
  screenshot: ScreenshotInfo | null
  /** Screenshot still being captured when the overlay is already visible. */
  screenshotPending: boolean
  excluded: boolean
  warnings: string[]
  collectedMs: number
}

export interface PermissionState {
  accessibility: boolean
  screenRecording: boolean
  /** Push-to-talk records the microphone; without it the card only types. */
  microphone: boolean
}

/** How a finished answer should be reworked: shorter or more detailed. */
export type RefineDirection = 'shorter' | 'longer'

interface RefineRequest {
  direction: RefineDirection
  /** The answer the user is looking at; the model reworks this exact text. */
  baseAnswer: string
}

export interface SendRequest {
  requestId: string
  prompt: string
  mode: ResponseMode
  includeSelection: boolean
  includeScreenshot: boolean
  /**
   * Set when the user is adjusting the length of an existing answer instead of
   * asking a new question. Context is not re-sent: only the previous answer.
   */
  refine?: RefineRequest
  /**
   * True when the prompt was spoken rather than typed.
   *
   * A voice turn must not print the model's narration while the agent is doing
   * the work: the action itself is on screen, and a card reading "нажимаю…"
   * competes with it. The main process uses this flag to hold the prose back
   * until it knows whether the turn is an answer or a plan. The renderer can then
   * show the answer only when there is text to read.
   */
  voice?: boolean
}

/** Which context sources the user left enabled in the overlay. */
export interface ContextFlags {
  includeSelection: boolean
  includeScreenshot: boolean
}

interface OverlayNotice {
  kind: 'info' | 'warning' | 'error'
  message: string
  /** Optional call to action rendered as a link-button in the overlay. */
  action?: 'openSettings' | 'openPermissions'
}

export interface OverlayState {
  sessionId: string
  context: ContextSnapshot
  flags: ContextFlags
  defaults: ContextFlags
  /** Set when provider/model/key are not ready; the overlay still opens. */
  setupNotice: OverlayNotice | null
  warnings: string[]
  /**
   * Whether the assistant is allowed to press and type right now. The card shows
   * the reason instead of offering an action that would silently do nothing.
   */
  agent: AgentAvailability
}

export type StreamEvent =
  | { type: 'chunk'; requestId: string; delta: string }
  /**
   * `annotations` is how many shapes were drawn over the screen for this answer.
   * Zero means the answer is text only, which is the normal case.
   */
  | { type: 'done'; requestId: string; text: string; annotations: number }
  | { type: 'error'; requestId: string; message: string; retryable: boolean }

/** Sent to the overlay whenever the drawing layer gained or lost shapes. */
export interface AnnotationsEvent {
  count: number
  visible: boolean
}

export interface ProviderInfo {
  id: ProviderId
  label: string
  defaultModel: string
  /** Used when the user leaves the base URL field empty. */
  defaultBaseUrl: string
  supportsVision: boolean
  keyUrl: string
}

export interface KeyStatus {
  provider: ProviderId
  configured: boolean
  encryptionAvailable: boolean
}

export interface PasteResult {
  ok: boolean
  /** Set when the answer was left in the clipboard instead of being typed. */
  copiedOnly: boolean
  message?: string
}

export interface TestKeyResult {
  ok: boolean
  message: string
}
