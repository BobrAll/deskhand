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

export interface QuickAction {
  id: string
  label: string
  prompt: string
  /** `insert` strips markdown, `analyze` keeps it. */
  mode: ResponseMode
}

/** What a finished transcript does: ask the model, or type it into the app. */
type VoiceAction = 'command' | 'dictate'

/** Hold-to-talk input: a local whisper model turns speech into text. */
export interface VoiceSettings {
  enabled: boolean
  /** Accelerator held down to talk, e.g. "Alt+Shift+Space". */
  hotkey: string
  /** Id from `WHISPER_MODELS`; the file itself lives in the models directory. */
  model: string
  /** Whisper language code, or `auto` to let the model detect it. */
  language: string
  /** `command` sends the transcript to the model, `dictate` types it into the app. */
  action: VoiceAction
  /** `command` only: send the recognised wording at once instead of filling the field. */
  autoSend: boolean
  /** A shorter press is treated as an accidental tap and thrown away. */
  minDurationMs: number
  /** Hard cap so a stuck key cannot record forever. */
  maxDurationMs: number
}

/**
 * Trackpad gestures: three fingers are the whole interface.
 *
 * One contact, two actions, and only time tells them apart — a short touch opens
 * the card, a longer one records. `holdMs` is that boundary, and it is a setting
 * because "short" is a personal threshold: a firm tap is 80 ms, a deliberate one
 * can be 250 ms, and someone who talks with their hands needs more room before a
 * brush of the pad becomes a recording.
 *
 * Gestures are additive: the keyboard shortcuts keep working exactly as before,
 * so a Mac without a trackpad loses nothing.
 */
export interface GestureSettings {
  enabled: boolean
  /**
   * How many fingers the gesture uses. Fixed at three: two are scroll and
   * right-click territory and four belong to Mission Control, so a configurable
   * count would only offer ways to break the system's own gestures.
   */
  fingers: number
  /** How long the fingers must stay down before a tap becomes a hold, in ms. */
  holdMs: number
}

/**
 * Agent mode: the assistant may take over the mouse and the keyboard.
 *
 * It is off by default and gated on three things at once — this switch, the
 * Accessibility permission (macOS only lets a trusted process post events into
 * another app) and an image of the screen to aim at. Every one of them can be
 * missing, so "enabled" here means "may", not "will".
 *
 * The numbers are deliberately slow by default. A machine that clicks four
 * times a second cannot be stopped by a human, and the point of the mode is that
 * the user keeps the last word: `startDelayMs` is the window in which Escape
 * still works before anything happens at all.
 */
export interface AgentSettings {
  /** Master switch. Off unless the user turned it on in the settings. */
  enabled: boolean
  /** Pause between the plan arriving and the first action, so Escape can win. */
  startDelayMs: number
  /** Pause between two actions; macOS needs a beat to deliver each event. */
  stepDelayMs: number
  /** Maximum plan rounds, including the initial plan; final verification is separate. */
  maxSteps: number
  /** Let the assistant type text into the focused field. */
  allowTyping: boolean
  /** Let the assistant press shortcuts (⌘S, ⌘W, ⌘Tab…). */
  allowShortcuts: boolean
  /** Moving the physical mouse takes control back immediately. */
  abortOnMouseMove: boolean
  /**
   * Look at the screen once more before saying the request is done.
   *
   * `@done` is the model's opinion about a frame that no longer exists: the plan
   * has clicked, typed and pressed since the picture it reasoned about was
   * taken. Without this the assistant reports success it has never seen, and the
   * first thing the user notices is that the thing did not happen. One extra
   * round is the price of the word «Готово» meaning something.
   */
  verifyResult: boolean
}

/**
 * Lifecycle of one agent run, mirrored into the overlay.
 *
 * `checking` is the turn after the last action and before "Готово": the plan has
 * run, and the assistant is looking at a fresh screenshot to decide whether the
 * request it was given is actually fulfilled. It is its own phase because
 * nothing is being pressed during it and the card must not say "Готово" while
 * the result is still unverified — that word is the whole claim the user is
 * checking against the screen.
 */
type AgentPhase =
  | 'idle'
  | 'arming'
  | 'acting'
  | 'checking'
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

/** One step of a plan, as it is shown in the card while it runs. */
export interface AgentEvent {
  phase: AgentPhase
  /** The whole task succeeded, rather than just one intermediate plan. */
  completed?: boolean
  /** 1-based index of the action being performed; 0 while arming. */
  step: number
  total: number
  /** What is happening, in the user's language ("Клик по «Экспорт»"). */
  label: string
  /** Every step of the plan, so the card can list what is still ahead. */
  plan: string[]
  /**
   * Steps that were dropped before running them, with the reason.
   *
   * A plan is a suggestion, and the parts of it that were refused are as much
   * the user's business as the parts that ran: silently doing five of six
   * actions would leave them believing the sixth happened.
   */
  skipped?: string[]
  /** Set on `error` / `aborted`: why the run stopped. */
  message?: string
}

/**
 * One frame of the ring that follows the pointer while a plan runs.
 *
 * The card can be behind another window or pushed aside, and the one place the
 * user is already looking is the pointer — which is also the thing moving on its
 * own. Mirroring the running step there is what turns "something happened" into
 * "it clicked Экспорт". Deliberately smaller than `AgentEvent`: the layer draws
 * a ring and one line, so it gets a ring and one line.
 */
export interface AgentCursorFrame {
  /** `false` plays the fade-out; the window is hidden right after it. */
  visible: boolean
  /** Pointer position *inside* the layer, in points. */
  anchor: { x: number; y: number }
  /** Which side of the pointer the caption hangs on. */
  side: 'above' | 'below'
  /**
   * `arming` = about to start, `acting` = a step is running, `waiting` = the turn
   * is between two plans (the screen is being read again) and the ring stays on
   * the pointer with no step to count.
   */
  phase: 'arming' | 'acting' | 'waiting' | 'success'
  /** What is happening, in the user's language ("Клик: «Экспорт»"). */
  label: string
  /** 1-based index of the running step; 0 while arming. */
  step: number
  total: number
  /** Bumped for every step, so the click ripple replays. */
  pulse: number
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
  /** Human-readable reason when `ready` is false. */
  detail: string | null
  /** Model file that will actually be used, or null when none was found. */
  modelPath: string | null
  /** `whisper-cli` binary that will actually be used. */
  binaryPath: string | null
  /** Where models are downloaded to. */
  modelsDir: string
  /** Ids of the models already on disk. */
  installed: string[]
  /** Set when the keyboard listener could not be started. */
  listenerError: string | null
  /** Set when the trackpad listener could not be started. */
  gestureError: string | null
}

export interface DownloadProgress {
  model: string
  received: number
  total: number
  done: boolean
  error?: string
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
  /**
   * Per-provider API base URL override (no trailing slash, no endpoint path).
   * Empty string means "use the provider default" — see `ProviderInfo.defaultBaseUrl`.
   */
  baseUrls: Record<ProviderId, string>
  temperature: number
  maxTokens: number
  systemPrompt: string
  /** Electron accelerator string, e.g. "Alt+Space". */
  hotkey: string
  captureScreenshotByDefault: boolean
  screenshotMaxSide: number
  screenshotQuality: number
  quickActions: QuickAction[]
  /** Bundle identifiers where Smart Cursor does nothing at all. */
  excludedApps: string[]
  launchAtLogin: boolean
  onboardingCompleted: boolean
  /** Push-to-talk voice input (local whisper). */
  voice: VoiceSettings
  /** Three-finger trackpad gestures: tap opens the card, hold records. */
  gestures: GestureSettings
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
 * One physical thing the assistant asked the machine to do.
 *
 * Coordinates are normalised against the screenshot the model was shown, exactly
 * like annotations, so they survive Retina scaling and a downscaled image: the
 * runner maps them onto `ScreenshotInfo.area` once, in points, and the helper
 * only ever sees screen points.
 */
export type AgentClickButton = 'left' | 'right' | 'double'

export type AgentAction =
  | {
      kind: 'click'
      at: Point01
      button: AgentClickButton
      /** What the model thinks it is clicking — shown in the card, never typed. */
      label?: string
    }
  | { kind: 'move'; at: Point01; label?: string }
  /** `text` is typed as-is into whatever field has focus. */
  | { kind: 'type'; text: string }
  /** A shortcut such as `cmd+s` or `enter`, parsed by `keys.ts`. */
  | { kind: 'key'; combo: string }
  | { kind: 'scroll'; dx: number; dy: number }
  | { kind: 'drag'; from: Point01; to: Point01; label?: string }
  | { kind: 'wait'; ms: number }
  /** The model says the task is finished; nothing is executed. */
  | { kind: 'done'; label?: string }
  /**
   * The model asks to look at the screen again before deciding what is next.
   *
   * It exists so a continuation is a decision the model makes rather than
   * something every turn pays for: an answer that clicks one button and stops
   * costs one request, and only a plan that genuinely cannot finish without
   * seeing the result spends a second one.
   */
  | { kind: 'look' }

/** One action as it is about to run, with everything resolved. */
export interface AgentPlanStep {
  action: AgentAction
  /** Human-readable line for the card ("Клик по «Экспорт»"). */
  label: string
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
  quickActions: QuickAction[]
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

/**
 * A completed plan waiting for the runner: what the model asked to do and the
 * frame its coordinates were measured against.
 */
export interface AgentRunRequest {
  requestId: string
  /** Prompt that produced the plan, so a continuation keeps the same intent. */
  prompt: string
  steps: AgentPlanStep[]
  /** Screen rectangle the normalised coordinates refer to, in points. */
  area: ScreenRect | null
  /** `true` when the plan ended with `@done` — nothing left to look at. */
  finished: boolean
  /**
   * `true` when the caller is going to check the result on a fresh screenshot
   * before it says anything about success.
   *
   * The runner would otherwise announce «Готово» the moment the last step
   * returned, and that word is precisely the claim under test: it must not appear
   * for a single frame and then be taken back. With this flag the run ends on a
   * neutral "смотрю, что получилось", and the caller owns the verdict.
   */
  verify?: boolean
}

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
  popularModels: string[]
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
