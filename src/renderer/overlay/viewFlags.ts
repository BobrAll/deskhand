/**
 * What the card shows, as a decision rather than as JSX.
 *
 * Every flag below used to be an expression inline in `App.tsx`, evaluated in the
 * middle of a render that also read refs, state and a `state` object that may be
 * `null`. That made them impossible to check without mounting the whole overlay —
 * and a renderer has no test environment here (no jsdom, no RTL), so in practice
 * they were checked by eye.
 *
 * They are pure: the same inputs give the same flags, nothing is read from a ref
 * and nothing is written. The card is then a matter of rendering them; visual
 * checks cover the folded card, answer layout, and agent row.
 */

import type { AgentAvailability, OverlayState, RefineDirection } from '@shared/types'
import { looksLikeAction } from '@shared/intent'

/** The last request, as the card remembers it for the retry and rewrite buttons. */
export interface LastRequest {
  prompt: string
  refine: RefineDirection | null
}

export interface ViewState {
  /** The session is there. `null` means the card is drawn before its context lands. */
  session: OverlayState | null
  /** The drawer behind the chevron. */
  expanded: boolean
  /** The answer field has text in it. */
  hasAnswer: boolean
  /** A request is in flight. */
  busy: boolean
  /** The last request failed, so the drawer must not fight the error line. */
  failed: boolean
  last: LastRequest | null
}

export interface ViewFlags {
  /** The app is in the exclusion list: nothing is sent, and the field is disabled. */
  blocked: boolean
  /** Everything below the field — including context tags — is folded behind the chevron. */
  showMeta: boolean
  /** There is a finished answer, and nothing is still writing over it. */
  answerReady: boolean
  /** Mouse control is switched off — the state the app ships in. */
  agentOff: boolean
  /** It is switched on but cannot run (no permission, no helper). */
  agentBlocked: boolean
  /** The request was phrased as an action and the mode that would perform it is off. */
  actionAsk: boolean
  /** The one warning worth a line, if any. */
  hint: string | null
  /** Anything the user has to see even in the folded, one-line state. */
  alert: boolean
}

/**
 * Derives the card's flags.
 *
 * Two of these are load-bearing enough to spell out:
 *
 * - `agentOff` and `agentBlocked` are *different* states, and the card treats them
 *   differently: off is an offer (a switch in the card), blocked is an explanation
 *   (why the switch would not help). Collapsing them was the bug this pair exists
 *   to prevent — "нарисовал вместо того, чтобы сделать" with no way to tell which.
 * - `actionAsk` excludes a rewrite. «Короче» on an answer that happens to read
 *   like an instruction is not a request to act, and offering the agent switch
 *   over it would be a non-sequitur.
 */
export function deriveView(state: ViewState): ViewFlags {
  const blocked = state.session?.context.excluded ?? false
  const agent: AgentAvailability | null = state.session?.agent ?? null

  const agentOff = agent ? !agent.enabled : false
  const agentBlocked = agent ? agent.enabled && !agent.ready : false
  const agentNotice = agentBlocked ? (agent?.reason ?? null) : null

  const actionAsk = !state.last?.refine && looksLikeAction(state.last?.prompt ?? '')

  const hint = state.session?.warnings.filter(Boolean)[0] ?? agentNotice

  return {
    blocked,
    showMeta: state.expanded && !state.hasAnswer && !state.failed,
    answerReady: state.hasAnswer && !state.busy,
    agentOff,
    agentBlocked,
    actionAsk,
    hint: hint ?? null,
    alert: Boolean(blocked || state.session?.setupNotice || state.failed || hint)
  }
}
