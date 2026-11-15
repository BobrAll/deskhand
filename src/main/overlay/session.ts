import type { ActiveAppInfo, Annotation, ContextFlags, ContextSnapshot } from '@shared/types'
import type { Exchange } from './request'

export interface CardExchange extends Exchange {
  bundleId: string | null
}

export interface Session {
  id: string
  snapshot: ContextSnapshot
  flags: ContextFlags
  /** The app that was frontmost when the hotkey fired. */
  target: ActiveAppInfo | null
  abort: AbortController | null
  requestId: string | null
  answer: string
  /** Shapes currently painted on the display for this session. */
  annotations: Annotation[]
  /**
   * The conversation so far, oldest first: the user's questions and the answers
   * they got. It is what makes "а почему?" a follow-up instead of a brand new
   * question — without it the model only ever sees the last sentence and has no
   * idea what "это" refers to.
   *
   * Capped at `CARD_HISTORY_TURNS` exchanges and trimmed before storage, because a
   * session can stay open for a while and an unbounded history would quietly
   * grow every request until it hit the context limit.
   */
  history: CardExchange[]
  /**
   * What went wrong during this turn but did not stop it.
   *
   * Its own list rather than a field on the snapshot: a context warning describes
   * the screen, and these describe the request. The card shows the first one, so
   * "the model rejected the screenshot, so this answer is text only" reaches the
   * person who asked rather than only the log.
   */
  notices: string[]
}
