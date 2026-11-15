import type { ContextSnapshot } from './context'
import type { AgentAvailability } from './agent'

/**
 * `insert` — plain text to paste into a field, `analyze` — markdown breakdown.
 *
 * There is deliberately no "guide" mode: drawing on the screen is a tool the
 * model invokes per answer (`@point` in the system prompt), not a mode the user
 * has to switch on beforehand.
 */
export type ResponseMode = 'insert' | 'analyze'

/** How a finished answer should be reworked: shorter or more detailed. */
export type RefineDirection = 'shorter' | 'longer'

export interface RefineRequest {
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

export interface OverlayNotice {
  /** A setup problem the card cannot fix itself: `error` is the red tone, `warning` the amber one. */
  kind: 'warning' | 'error'
  message: string
}

export interface OverlayState {
  sessionId: string
  context: ContextSnapshot
  flags: ContextFlags
  /** Set when provider/model/key are not ready; the overlay still opens. */
  setupNotice: OverlayNotice | null
  warnings: string[]
  /**
   * Whether the assistant is allowed to press and type right now. The card shows
   * the reason instead of offering an action that would silently do nothing.
   */
  agent: AgentAvailability
}

/**
 * A machine-readable reason for the two failures the card treats differently.
 *
 * `timeout` means the run was cut off by its deadline, so the result is not
 * known — the card and the voice both say "check what happened" rather than
 * "nothing happened".
 */
export type StreamEventCode = 'timeout'

export type StreamEvent =
  | { type: 'chunk'; requestId: string; delta: string }
  /**
   * `annotations` is how many shapes were drawn over the screen for this answer.
   * Zero means the answer is text only, which is the normal case.
   */
  | { type: 'done'; requestId: string; text: string; annotations: number }
  | {
      type: 'error'
      requestId: string
      message: string
      retryable: boolean
      code?: StreamEventCode
    }

/** Sent to the overlay whenever the drawing layer gained or lost shapes. */
export interface AnnotationsEvent {
  count: number
}

export interface PasteResult {
  ok: boolean
  /** Set when the answer was left in the clipboard instead of being typed. */
  copiedOnly: boolean
  message?: string
}
