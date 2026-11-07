/**
 * A plan is what the model asked to do; this module decides what of it may run.
 *
 * The model is a suggestion engine, not an authority: it may propose eight
 * clicks, a shortcut nobody bound, or text meant for a password field. Everything
 * that reaches the mouse goes through `normalizePlan` first, so the runner only
 * ever executes a list that is short, resolvable and inside the frame the
 * coordinates were measured against.
 *
 * Pure module: no Electron, no Node.
 */

import type { AgentPlanStep, AgentSettings, ScreenRect } from '@shared/types'
import { parseShortcut } from './keys'
import { navigationUrl, parseWebUrl } from './navigation'

/**
 * How many actions one plan may contain.
 *
 * Six is "open the menu, click export, choose a format, type a name, press
 * enter" — a whole small task. More than that in one shot is not a plan any
 * more, it is a program written by someone who cannot see the screen.
 */
export const MAX_PLAN_STEPS = 6

/** Longer than this is a paragraph pasted by accident, not a field being filled. */
export const MAX_TYPE_CHARS = 600

interface PlanRejection {
  step: number
  label: string
  reason: string
}

export interface NormalizedPlan {
  steps: AgentPlanStep[]
  /** Steps that were dropped, with the reason, so the card can say what it skipped. */
  rejected: PlanRejection[]
  /** `true` when the model ended the plan with `@done`. */
  finished: boolean
  /**
   * The model asked to see the screen again before going on.
   *
   * Pulled out of `steps` rather than kept in them: it is not something the
   * mouse does, it is a request about the *next* request, and the runner would
   * only fail on it.
   */
  wantsLook: boolean
}

function insideFrame(point: { x: number; y: number }, area: ScreenRect | null): boolean {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y) || point.x < 0 || point.x > 1 || point.y < 0 || point.y > 1) return false
  // Without a captured rectangle there is nothing to clamp against; the caller
  // refuses the whole plan in that case, so a point is only checked here.
  return area ? area.width > 0 && area.height > 0 : true
}

/**
 * Filters a parsed plan down to what may actually run.
 *
 * The order of the checks matters: a disabled capability is reported before a
 * malformed step, because "печать выключена" is actionable and "неизвестная
 * комбинация" usually is not.
 */
export function normalizePlan(
  raw: AgentPlanStep[],
  options: { settings: AgentSettings; area: ScreenRect | null; prompt?: string }
): NormalizedPlan {
  const { settings, area, prompt } = options
  const steps: AgentPlanStep[] = []
  const rejected: PlanRejection[] = []
  let finished = false
  let wantsLook = false

  for (const [index, step] of raw.entries()) {
    const action = step.action

    if (action.kind === 'look') {
      wantsLook = true
      // `@look` is a checkpoint, not a no-op: the model writes it because the
      // next step depends on what is about to appear ("открылось ли меню").
      // Running the lines after it against the *old* screenshot would be exactly
      // the blind click the tool exists to avoid, so the plan stops here and the
      // continuation re-plans the rest from a fresh frame.
      break
    }

    if (action.kind === 'done') {
      finished = true
      steps.push(step)
      // `@done` ends the plan: anything written after it was a model mistake.
      break
    }

    // Control markers do not spend the action budget: six actions followed by
    // @look must still request an observation, not reject the entire chain.
    if (steps.length >= MAX_PLAN_STEPS) {
      rejected.push({
        step: index + 1,
        label: step.label,
        reason: `Больше ${MAX_PLAN_STEPS} действий за раз — остальное не выполняю.`
      })
      continue
    }

    if (action.kind === 'click-marker') {
      rejected.push({ step: index + 1, label: step.label, reason: 'Такой метки нет на текущем снимке.' })
      continue
    }

    if (action.kind === 'type') {
      if (!settings.allowTyping) {
        rejected.push({ step: index + 1, label: step.label, reason: 'Печать отключена.' })
        continue
      }
      const { text } = action
      if (text.length > MAX_TYPE_CHARS) {
        rejected.push({ step: index + 1, label: step.label, reason: `Текст превышает лимит в ${MAX_TYPE_CHARS} единиц UTF-16.` })
        continue
      }
      if (/[\uD800-\uDFFF]/u.test(text)) {
        rejected.push({ step: index + 1, label: step.label, reason: 'В тексте есть повреждённый символ Unicode.' })
        continue
      }
      if (!text.trim()) {
        rejected.push({ step: index + 1, label: step.label, reason: 'Пустой текст.' })
        continue
      }
      steps.push({ action: { kind: 'type', text }, label: step.label })
      continue
    }

    if (action.kind === 'key') {
      if (!settings.allowShortcuts) {
        rejected.push({ step: index + 1, label: step.label, reason: 'Клавиши отключены.' })
        continue
      }
      if (!parseShortcut(action.combo)) {
        rejected.push({
          step: index + 1,
          label: step.label,
          reason: `Неизвестная комбинация: ${action.combo}`
        })
        continue
      }
      steps.push(step)
      continue
    }

    if (action.kind === 'click' || action.kind === 'move' || action.kind === 'drag') {
      if (!insideFrame(action.kind === 'drag' ? action.from : action.at, area)) {
        rejected.push({ step: index + 1, label: step.label, reason: 'Точка вне скриншота.' })
        continue
      }
      if (action.kind === 'drag' && !insideFrame(action.to, area)) {
        rejected.push({ step: index + 1, label: step.label, reason: 'Точка вне скриншота.' })
        continue
      }
      steps.push(step)
      continue
    }

    if (action.kind === 'navigate' || action.kind === 'browser') {
      if (steps.length > 0) {
        rejected.push({ step: index + 1, label: step.label, reason: 'Открытие страницы должно быть первым действием.' })
        break
      }
      // If the request names a site without providing this address, open the
      // browser itself. The next plan can search using the observed browser.
      if (action.kind === 'navigate' && prompt !== undefined &&
          !navigationUrl(action.url, prompt) && parseWebUrl(action.url)) {
        steps.push({ action: { kind: 'browser' }, label: 'Открыть браузер для поиска сайта по названию' })
      } else {
        steps.push(step)
      }
      wantsLook = true
      break
    }
    steps.push(step)
  }

  if (rejected.length) return { steps: [], rejected, finished: false, wantsLook: false }
  return { steps, rejected, finished, wantsLook }
}
