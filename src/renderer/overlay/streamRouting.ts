/**
 * Which stream event belongs to which card.
 *
 * The card keeps four refs — the request it is waiting on, the request it has
 * given up on, whether the next chunk replaces rather than appends, and whether a
 * spoken phrase is still in the field. The *decision* about an incoming event is a
 * pure function of those four values and the event; only the decision is here.
 *
 * The refs stay in `App`. They are one piece of coupled state (A1.6): the ignored
 * request is only meaningful next to the awaited one, and splitting them across
 * modules would let two of them disagree. What moves out is the reasoning.
 *
 * The case worth naming: a late chunk. The user cancelled, the card stopped
 * waiting, and a chunk already in flight arrives anyway. It must not be appended
 * to an answer nobody asked for any more — which is why "is this request still
 * ours?" is asked before anything else is looked at.
 */

import type { StreamEvent } from '@shared/types'

/** What the card should do with the event. */
export type StreamAction =
  /** Add the delta to the end of the answer. */
  | { kind: 'append'; text: string; clearSpoken: boolean }
  /** Start the answer over with this delta — a rewrite's first chunk. */
  | { kind: 'replace'; text: string; clearSpoken: boolean }
  /** The turn ended; this is the authoritative text. */
  | { kind: 'done'; text: string; clearSpoken: boolean }
  /** The turn ended in a failure. */
  | {
      kind: 'error'
      message: string
      retryable: boolean
      /** Present when the failure has a kind the card reacts to differently. */
      code?: Extract<StreamEvent, { type: 'error' }>['code']
      clearSpoken: boolean
    }
  /** Not ours, or a chunk that arrived after the card stopped waiting. */
  | { kind: 'ignore' }

export interface StreamState {
  /** The request the card is waiting on, if any. */
  requestId: string | null
  /** The request the card has already given up on. */
  ignoredRequest: string | null
  /** The next chunk replaces the answer instead of extending it. */
  replaceOnChunk: boolean
  /** A spoken phrase is still sitting in the field. */
  spokenPrompt: boolean
}

/**
 * Whether a rewrite starts the answer over on its first chunk.
 *
 * A rewrite keeps the answer it is rewriting on screen until the model produces
 * something — a card that blanked while «Короче» worked would lose the text the
 * user is still reading. So the rule follows the screen, not the request: a
 * retry starts from the very same text, and its first chunk has to replace that
 * text as well, or the new attempt would be glued onto the old answer.
 */
export function rewriteStartsOver(answerOnScreen: string): boolean {
  return answerOnScreen.trim().length > 0
}

/**
 * Decides what an event means.
 *
 * `clearSpoken` is reported on every event that gets through, not only on chunks:
 * an answer that never streamed — an action with no prose, a failure — leaves the
 * phrase behind too, and the card has stopped working on it either way.
 */
export function routeStream(event: StreamEvent, state: StreamState): StreamAction {
  // A request the card has already given up on: anything still in flight for it is
  // a leftover, not an answer.
  if (event.requestId === state.ignoredRequest) return { kind: 'ignore' }
  // A request that is not the one being waited on is a leftover. The guard only
  // applies while there is a request to wait for: with none in flight the card is
  // not waiting, so any event is accepted.
  if (state.requestId !== null && event.requestId !== state.requestId) return { kind: 'ignore' }

  const clearSpoken = state.spokenPrompt

  if (event.type === 'chunk') {
    return {
      kind: state.replaceOnChunk ? 'replace' : 'append',
      text: event.delta,
      clearSpoken
    }
  }

  if (event.type === 'done') {
    return { kind: 'done', text: event.text, clearSpoken }
  }

  return {
    kind: 'error',
    message: event.message,
    retryable: event.retryable,
    code: event.code,
    clearSpoken
  }
}
