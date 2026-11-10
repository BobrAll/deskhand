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

import type { AgentPhase } from '@shared/types'

/**
 * The agent row's phase.
 *
 * Re-exported under a local name so the key policy stays readable: this file
 * asks "what is the run doing" and the answer is the same union the card gets.
 * The phases it distinguishes are the ones with a key of their own; the rest
 * behave like "nothing running".
 */
export type RunPhase = AgentPhase

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
    // Escape is watching the screen, not the card.
    if (input.agentPhase === 'asking') {
      // A question is a stop point like any other: Escape refuses it. It is not
      // `cancel` — the card has no request of its own to abort here — and it is
      // not `close` either, because closing the card would leave the agent
      // blocked on a question nobody can see any more.
      return 'stopAgent'
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
