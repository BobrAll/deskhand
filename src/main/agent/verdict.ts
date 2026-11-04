/**
 * Reads the answer to "получилось ли?" — the one question the verification
 * request asks.
 *
 * The model answers in the same line protocol it uses for acting, so the reply
 * has to be classified before anything is executed. Kept out of the overlay and
 * free of Electron on purpose: this is the decision that decides whether the card
 * is allowed to say «Готово», and a decision like that should be readable and
 * testable on its own (see `.scratch/verify-probe`).
 */

import type { AgentPlanStep } from '@shared/types'
import type { NormalizedPlan } from './plan'

export interface Verdict {
  /**
   * `confirmed` — the screen was looked at and the request is visibly done.
   * `unconfirmed` — looked, and it is not (or the model dodged the question).
   * `fix` — not done, and here are the steps that would fix it.
   */
  kind: 'confirmed' | 'unconfirmed' | 'fix'
  /** Steps to run for `fix`; empty otherwise. Never contains `@done`. */
  actions: AgentPlanStep[]
}

/**
 * Classifies one verification answer.
 *
 * The rules come from the prompt, but they are enforced here because the model is
 * a suggestion engine and this is the one place where believing it costs the
 * user a false "готово":
 *
 * • `@done` is a claim, not a step. It is stripped from the actions and read as
 *   the answer itself.
 * • `@done` together with actions is *not* a pass: the screen it declares success
 *   about is the one before those actions. Such an answer is a fix with an
 *   opinion attached.
 * • On the last check `canFix` is false: an action there would be performed with
 *   nobody left to look at the result, so actions mean "dodged the question" and
 *   the turn ends unconfirmed rather than on the model's reassurance.
 */
export function readVerdict(plan: NormalizedPlan, options: { canFix: boolean }): Verdict {
  const actions = plan.steps.filter((step) => step.action.kind !== 'done')

  if (actions.length === 0) {
    // Nothing to press. `@done` among the words is the claim that they describe a
    // finished job; prose without it is the model answering "смотрю — и не вижу".
    return { kind: plan.finished ? 'confirmed' : 'unconfirmed', actions: [] }
  }

  // Actions with no budget left to judge them: unconfirmed, not a plan.
  if (!options.canFix) return { kind: 'unconfirmed', actions: [] }

  return { kind: 'fix', actions }
}