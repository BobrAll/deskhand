import { createHash } from 'node:crypto'
import type { AgentPlanStep, ScreenshotInfo } from '@shared/types'

/** Per-turn memory: do not replay a mutation against the same observed state. */
export class ProgressGuard {
  private attempted = new Set<string>()

  allow(steps: AgentPlanStep[], shot: ScreenshotInfo | null): boolean {
    const actions = steps.map((step) => step.action)
      .filter((action) => action.kind !== 'done' && action.kind !== 'look' && action.kind !== 'wait')
    if (!shot || actions.length === 0) return true
    const key = createHash('sha256')
      .update(shot.dataUrl)
      .update(JSON.stringify(shot.area))
      .update(JSON.stringify(actions))
      .digest('hex')
    if (this.attempted.has(key)) return false
    this.attempted.add(key)
    return true
  }
}

export const REPEATED_PLAN = 'Эта цепочка уже выполнялась на таком же экране и не привела к цели. ' +
  'Повтор не выполнен. Выбери другой способ или объясни конкретное препятствие.'
