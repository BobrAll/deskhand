import { createHash } from 'node:crypto'
import type { AgentPlanStep, ScreenshotInfo } from '@shared/types'

/** Per-turn memory: do not replay a mutation against the same observed state. */
export class ProgressGuard {
  private attempted = new Set<string>()
  private navigated = new Set<string>()
  private openedBrowser = false

  allow(steps: AgentPlanStep[], shot: ScreenshotInfo | null): boolean {
    const actions = steps.map((step) => step.action)
      .filter((action) => action.kind !== 'done' && action.kind !== 'look' && action.kind !== 'wait')
    if (actions.some((action) => action.kind === 'browser')) {
      if (this.openedBrowser) return false
      this.openedBrowser = true
    }
    const navigation = actions.find((action) => action.kind === 'navigate')
    if (navigation) {
      const url = URL.canParse(navigation.url) ? new URL(navigation.url).href : navigation.url
      if (this.navigated.has(url)) return false
      this.navigated.add(url)
    }
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

export const REPEATED_PLAN = 'Этот переход уже запрашивался или эта цепочка уже выполнялась на таком же экране. ' +
  'Повтор не выполнен. Выбери другой способ или объясни конкретное препятствие.'
