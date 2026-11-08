/**
 * The agent row's three decisions, as functions rather than as JSX.
 *
 * All three used to be inline in `App.tsx`, in the middle of a render. That made
 * the one that mattered — whether to draw a checkmark — impossible to check
 * without opening the overlay, and it is exactly the decision that was wrong: a
 * run that ran out of steps ended with `completed: true` and got a green
 * checkmark over a task it had not done.
 *
 * Nothing here reads a ref or a setting; the same event gives the same answer.
 */

import type { AgentEvent } from '@shared/types'

/** What the head of the agent row draws. */
export type AgentMark =
  /** The task was done: the checkmark. */
  | 'done'
  /** It ended without finishing: the dot, in the warning colour. */
  | 'failed'
  /** Still working, or waiting for an answer: the dot, in the phase colour. */
  | 'progress'

/**
 * Whether the run actually succeeded.
 *
 * `completed` is the agent's own verdict and the only thing consulted. A phase of
 * `done` is not enough on its own: the loop ends with that phase whether or not
 * it finished the task, and reading the phase alone is what drew the checkmark
 * over a failure.
 */
export function agentMark(event: AgentEvent): AgentMark {
  if (event.phase !== 'done') return 'progress'
  return event.completed ? 'done' : 'failed'
}

/**
 * The line under the head.
 *
 * A failed run says what happened; a successful one says "Готово" or, when the
 * agent had something more specific to say, that. The order matters: `message`
 * on a successful run is a detail, and on a failed one it is the whole point.
 */
export function agentLabel(event: AgentEvent): string {
  if (event.phase === 'arming') return 'Нажму через мгновение — Escape отменит'
  if (event.phase === 'aborted' || event.phase === 'error') {
    return event.message ?? 'Остановлено'
  }
  if (event.phase === 'done' && event.completed === false) {
    return event.message ?? 'Задача осталась невыполненной'
  }
  return event.label || 'Готово'
}

/**
 * Whether the step counter belongs on screen.
 *
 * Only while there is still work: after the run ends, "3/3" reads as a
 * completion badge even when the run failed.
 */
export function agentShowsCount(event: AgentEvent): boolean {
  return event.total > 0 && (event.phase === 'acting' || event.phase === 'asking')
}
