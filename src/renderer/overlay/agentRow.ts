import type { AgentEvent } from '@shared/types'

/** What the head of the agent row draws. */
export type AgentMark =
  /** The task was done. */
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

/** The current action or a terminal message that is not already in the answer. */
export function agentLabel(event: AgentEvent, answer = ''): string | null {
  if (event.phase === 'arming') return 'Подготовка'
  if (event.phase === 'acting') return event.label || 'Работаю…'

  let status: string
  if (event.phase === 'aborted' || event.phase === 'error') {
    status = event.message ?? 'Остановлено'
  } else if (event.phase === 'done' && !event.completed) {
    status = event.message ?? 'Задача осталась невыполненной'
  } else {
    return null
  }
  return status.trim() === answer.trim() ? null : status
}
