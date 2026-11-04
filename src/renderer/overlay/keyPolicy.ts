/**
 * What a key press means to the card.
 *
 * The handler used to be one long function inside `App.tsx`, closing over four
 * callbacks, two refs and a piece of live state. Nothing about it was testable
 * without mounting the overlay, and the ordering of the Escape branches is the
 * whole feature: Escape during a plan is "стоп", not "закрыть".
 *
 * This module decides *what* the key means. It does not perform it — no refs are
 * written, no IPC is sent, nothing is prevented. The caller does that, because
 * those effects need the live component; the decision needs nothing.
 *
 * The two Enter handlers stay two. `keyPolicy` is consulted by the window-level
 * `keydown` *and* by the textarea's own `onKeyDown`, which is deliberate: the
 * textarea sees the keystroke first and stops it, so the window handler is the
 * fallback for Enter pressed anywhere else. Merging them into one listener would
 * change which element swallows the key — that is a behaviour change, not a
 * refactor.
 */

/**
 * The agent row's phase, spelled out here rather than imported.
 *
 * `AgentPhase` is declared in `@shared/types` but not exported — it is an
 * implementation detail of `AgentEvent`. The three phases this file cares about
 * are the ones with a key of their own; the rest behave like "nothing running".
 */
export type RunPhase = 'idle' | 'arming' | 'acting' | 'checking' | 'done' | 'aborted' | 'error'

/** What the card should do about the key press. */
export type KeyAction =
  | 'close'
  | 'cancel'
  | 'stopAgent'
  | 'paste'
  | 'copy'
  | 'send'
  /** The key is not ours; leave the event alone. */
  | null

export interface KeyInput {
  key: string
  /** Cmd on macOS, Ctrl elsewhere — the card does not distinguish them. */
  meta: boolean
  shift: boolean
  /** `tagName` of the focused element, when there is one. */
  tagName: string | null
  /** The agent row's phase, when a run is on screen. */
  agentPhase: RunPhase | null
  /** Whether a request is in flight — a check can be cancelled, a run stopped. */
  hasRequestId: boolean
  /** Whether anything is selected on the page. */
  hasSelection: boolean
  /** Whether there is an answer to copy. */
  hasAnswer: boolean
}

/**
 * Reads the key.
 *
 * Escape comes first and is exhaustive: a run on screen owns the key, and only a
 * card with nothing running closes on it.
 */
export function keyPolicy(input: KeyInput): KeyAction {
  if (input.key === 'Escape') {
    // While a plan runs, Escape is "стоп", not "закрыть": the card closing would
    // hide the very row that reports what was interrupted, and the user pressing
    // Escape is watching the screen, not the bubble.
    if (input.agentPhase === 'checking') {
      // `checking` belongs to the run as much as the plan does — the user is
      // waiting on a request they can still stop — but it stops differently:
      // nothing is moving, so there is no run to stop, and the request in flight
      // is what has to be cancelled. With no request to cancel, there is nothing
      // left to stop and the card closes as usual.
      return input.hasRequestId ? 'cancel' : 'close'
    }
    if (input.agentPhase === 'arming' || input.agentPhase === 'acting') return 'stopAgent'
    return 'close'
  }

  const meta = input.meta

  // ⌘⏎ pastes the answer — the same thing the «Вставить» button does.
  if (meta && input.key === 'Enter') return 'paste'

  // ⌘C copies the answer, but only when there is nothing selected: a real
  // selection is the user copying text out of the card themselves, and taking
  // that over would copy the whole answer instead of the part they highlighted.
  if (meta && input.key.toLowerCase() === 'c') {
    if (input.hasSelection) return null
    return input.hasAnswer ? 'copy' : null
  }

  // Enter sends, but only from the field: the card is not a form, and a stray
  // Enter over a button must not fire a request. Shift+Enter is a newline.
  if (input.key === 'Enter' && !meta && !input.shift) {
    return input.tagName === 'TEXTAREA' ? 'send' : null
  }

  return null
}
