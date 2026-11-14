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

/** «1 шаг», «3 шага», «11 шагов»: the count is read, not decoded. */
export function actionCount(count: number): string {
  const lastTwo = count % 100
  const last = count % 10
  if (last === 1 && lastTwo !== 11) return `${count} шаг`
  if (last >= 2 && last <= 4 && (lastTwo < 12 || lastTwo > 14)) return `${count} шага`
  return `${count} шагов`
}

/**
 * The line a finished run leaves on the card.
 *
 * Success is the agent's verdict, not the phase: a run that ended without
 * finishing still has `phase: 'done'`. The step count is part of the sentence
 * because "Готово" without it is a claim without evidence.
 */
export function agentSummary(event: AgentEvent, answer = ''): string | null {
  if (event.phase !== 'done' && event.phase !== 'aborted' && event.phase !== 'error') return null
  // The live counter is the agent's step number, so the finished sentence uses
  // the same number rather than the count of tool calls inside those steps.
  const steps = event.step > 0 ? event.step : (event.actions?.length ?? 0)
  if (event.phase === 'done' && event.completed) {
    return `Готово${steps > 0 ? ` · ${actionCount(steps)}` : ''}`
  }
  const message = agentLabel(event, answer)
  if (!message) return `Не выполнено${steps > 0 ? ` · ${actionCount(steps)}` : ''}`
  return steps > 0 ? `${message} · ${actionCount(steps)}` : message
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
