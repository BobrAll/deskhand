/**
 * One round of a turn, streamed: provider deltas in, painted shapes and prose out.
 *
 * Moved verbatim out of `createOverlayController().streamRound`. The seam is
 * exactly the chain that has nothing to do with windows: call the provider, feed
 * every delta through `ResponseStream`, drop unusable coordinates, and hand the
 * two things a round produces — drawable shapes and prose — to whoever owns the
 * screen. The controller keeps its own half: which messages to send, whether the
 * screen may be drawn on at all, and whether the prose is shown now or held back
 * until the turn is known to be an answer rather than an action.
 *
 * The point of the split is that this half is testable with a fake provider: a
 * marker split across chunks, a tail that only becomes a marker at `finish()`, a
 * turn cancelled mid-stream — all of it is decided here.
 */

import type { AgentPlanStep, Annotation } from '@shared/types'
import { isDrawable } from './annotations'
import type { ChatMessage, LlmProvider, StreamOptions } from './llm/provider'
import { ResponseStream } from './response'

export interface TurnStreamOptions {
  /** The provider that answers this round. */
  provider: LlmProvider
  messages: ChatMessage[]
  apiKey: string
  streamOptions: StreamOptions
  /**
   * Still worth consuming?
   *
   * Checked after every delta because a round outlives the thing it was started
   * for: the card can be closed, or the user can press Escape, while the model is
   * still writing. False means "stop now and keep whatever was parsed".
   */
  isAlive(): boolean
  /** Drawable shapes parsed out of the last delta; called only when non-empty. */
  onShapes(shapes: Annotation[]): void
  /** Prose parsed out of the last delta; called only when non-empty. */
  onText(delta: string): void
}

export interface TurnStreamResult {
  /** Everything the model asked to do, in the order it said it. */
  steps: AgentPlanStep[]
  /** The prose this round produced, whether or not it was shown. */
  text: string
}

/**
 * Consumes one streamed answer.
 *
 * The result is returned even when the round was cut short, so the caller can
 * treat a held round, a streamed one and a cancelled one uniformly.
 */
export async function consumeTurnStream(options: TurnStreamOptions): Promise<TurnStreamResult> {
  const { provider, messages, apiKey, streamOptions, isAlive, onShapes, onText } = options

  // The stream is filtered even when the tools were not offered: a raw
  // `@point circle …` or `@click 0.4 0.5` printing into the card or into a
  // pasted answer would be worse than no tool at all, and a model that ignores
  // its instructions is exactly the case a parser has to survive.
  const parser = new ResponseStream()

  /**
   * The prose produced by this round.
   *
   * Accumulated here rather than by the caller so a held round and a streamed one
   * are returned the same way.
   */
  let text = ''

  const append = (delta: string): void => {
    if (!delta || !isAlive()) return
    text += delta
    onText(delta)
  }

  /** Unusable coordinates are dropped here, once, for every round. */
  const paint = (shapes: Annotation[]): void => {
    const drawable = shapes.filter(isDrawable)
    if (drawable.length > 0) onShapes(drawable)
  }

  for await (const chunk of provider.stream(messages, apiKey, streamOptions)) {
    if (!isAlive()) return { steps: [], text }
    const parsed = parser.push(chunk.delta)
    paint(parsed.annotations)
    append(parsed.text)
  }
  if (!isAlive()) return { steps: [], text }

  // Whatever the parser was still holding back: a trailing partial line, or
  // text that never became a marker.
  const tail = parser.finish()
  paint(tail.annotations)
  append(tail.text)

  return { steps: parser.plan(), text }
}
