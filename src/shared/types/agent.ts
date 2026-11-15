import type { ScreenRect } from './context'

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
  /**
   * Write a per-run trace with the exact prompts, window titles and screenshots.
   *
   * Off by default: the aggregate `agent-trace.jsonl` already answers why a run
   * was slow, while these files hold everything the user saw and typed. They are
   * a debugging tool, not a history, so turning this on is a deliberate choice.
   */
  saveRunTraces: boolean
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
  /** The agent is blocked specifically by macOS Accessibility. */
  needsAccessibility?: boolean
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
   * "Больше не спрашивать" stores this, not the sentence around it: the same button
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
   * Something the run had to work around and kept going through.
   *
   * A warning from the loop, not a failure: the run is still alive and its
   * answer is still an answer. The card shows the first one when nothing more
   * urgent is on screen. Right now this carries "the model refused the
   * screenshot, so the rest of the run is without one".
   */
  notice?: string
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
   * The card shows only the current step and its label; the full log travels on
   * the event for the run trace and for callers that need the sequence.
   */
  actions?: AgentActionRow[]
  /** Set on `error` / `aborted`: why the run stopped. */
  message?: string
  /**
   * A machine-readable reason for the few events the card reacts to differently.
   *
   * `blocked` is "the run never started", which the card should not report as a
   * failure of the work; `secret` is the policy refusing to type a password. Both
   * used to be recognisable only by matching the Russian sentence.
   */
  code?: 'blocked' | 'secret'
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
  /** What actually happened, one row per call, for the run trace and the summary. */
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

/**
 * The cursor's own vocabulary, not a copy of `AgentPhase`.
 *
 * `arming` and `acting` are the phases of the same name; `waiting` covers
 * everything that is not a running step — the run stopped on a question, or the
 * turn is preparing its next call and reading the screen — and `success` is
 * `AgentPhase.done` with `completed` set. The glow has no "aborted" or "error":
 * on those the window is simply hidden.
 */
export type AgentCursorPhase = 'arming' | 'acting' | 'waiting' | 'success'

/** State of the agent's screen glow at the pointer. */
export interface AgentCursorFrame {
  /** `false` plays the fade-out; the window is hidden right after it. */
  visible: boolean
  /** Pointer position *inside* the layer, in points. */
  anchor: { x: number; y: number }
  /** What the glow is doing; see `AgentCursorPhase` for how it maps to `AgentPhase`. */
  phase: AgentCursorPhase
}

/**
 * What kind of gesture an action will look like.
 *
 * Mirrors the Swift `ActionPresentation.Gesture`. The layer uses it to choose
 * an animation, never to decide whether the action is allowed: the host has
 * already approved the call by the time this arrives.
 */
export type AgentGesture = 'click' | 'secondary' | 'type' | 'value' | 'select' | 'key' | 'scroll' | 'drag' | 'activate'

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
