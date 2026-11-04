import { describe, expect, it } from 'vitest'

import type { AgentPlanStep, AgentSettings, ScreenRect } from '@shared/types'
import { DEFAULT_AGENT } from '@shared/defaults'
import { MAX_PLAN_STEPS, MAX_TYPE_CHARS, normalizePlan } from './plan'
import { readVerdict } from './verdict'

const area: ScreenRect = { x: 0, y: 0, width: 1440, height: 900 }

const settings: AgentSettings = { ...DEFAULT_AGENT }

function step(label: string, action: AgentPlanStep['action']): AgentPlanStep {
  return { label, action }
}

const click = (x: number, y: number, name = 'Экспорт'): AgentPlanStep =>
  step(`Клик: «${name}»`, { kind: 'click', at: { x, y }, button: 'left', label: name })

const done = (): AgentPlanStep => step('Готово', { kind: 'done' })

const look = (): AgentPlanStep => step('Взгляну на результат', { kind: 'look' })

const normalize = (raw: AgentPlanStep[], overrides: Partial<AgentSettings> = {}) =>
  normalizePlan(raw, { settings: { ...settings, ...overrides }, area })

describe('normalizePlan: limits', () => {
  it('keeps up to six steps and rejects the rest', () => {
    const raw = Array.from({ length: 8 }, (_, index) => click(0.1, 0.1, `к${index}`))

    const plan = normalize(raw)

    expect(plan.steps).toHaveLength(MAX_PLAN_STEPS)
    expect(plan.rejected).toHaveLength(2)
    expect(plan.rejected[0].reason).toContain(String(MAX_PLAN_STEPS))
  })

  it('counts the rejected steps by their position in the original plan', () => {
    const raw = Array.from({ length: 7 }, () => click(0.1, 0.1))

    expect(normalize(raw).rejected[0].step).toBe(7)
  })

  it('truncates typed text at 600 characters', () => {
    const plan = normalize([step('Печать', { kind: 'type', text: 'я'.repeat(2000) })])

    expect(plan.steps[0].action).toEqual({ kind: 'type', text: 'я'.repeat(MAX_TYPE_CHARS) })
  })

  it('keeps the documented 600-character ceiling', () => {
    // The test above compares against the constant itself, so it stays green if
    // the number moves. Only a literal pins what the product promises.
    expect(MAX_TYPE_CHARS).toBe(600)
  })

  it('rejects an empty typed text', () => {
    const plan = normalize([step('Печать', { kind: 'type', text: '   ' })])

    expect(plan.steps).toEqual([])
    expect(plan.rejected[0].reason).toBe('Пустой текст.')
  })
})

describe('normalizePlan: disabled capabilities', () => {
  it('rejects typing when typing is off', () => {
    const plan = normalize([step('Печать', { kind: 'type', text: 'привет' })], {
      allowTyping: false
    })

    expect(plan.steps).toEqual([])
    expect(plan.rejected[0].reason).toBe('Печать отключена.')
  })

  it('rejects shortcuts when shortcuts are off', () => {
    const plan = normalize([step('Клавиши', { kind: 'key', combo: 'cmd+s' })], {
      allowShortcuts: false
    })

    expect(plan.steps).toEqual([])
    expect(plan.rejected[0].reason).toBe('Клавиши отключены.')
  })

  it('reports the disabled capability before a malformed step', () => {
    const plan = normalize([step('Клавиши', { kind: 'key', combo: 'не-комбинация' })], {
      allowShortcuts: false
    })

    expect(plan.rejected[0].reason).toBe('Клавиши отключены.')
  })

  it('still lets a click through when both typing and shortcuts are off', () => {
    const plan = normalize([click(0.5, 0.5)], { allowTyping: false, allowShortcuts: false })

    expect(plan.steps).toHaveLength(1)
  })
})

describe('normalizePlan: shortcuts', () => {
  it('keeps a resolvable combination', () => {
    expect(normalize([step('Клавиши', { kind: 'key', combo: 'cmd+s' })]).steps).toHaveLength(1)
  })

  it('rejects an unresolvable combination', () => {
    const plan = normalize([step('Клавиши', { kind: 'key', combo: 'cmd+nonsense' })])

    expect(plan.steps).toEqual([])
    expect(plan.rejected[0].reason).toContain('Неизвестная комбинация')
  })
})

describe('normalizePlan: coordinates', () => {
  it('keeps a click inside the frame', () => {
    expect(normalize([click(0.5, 0.5)]).steps).toHaveLength(1)
  })

  it('rejects a point outside the normalised frame', () => {
    const plan = normalize([click(1.4, 0.5), click(0.5, -0.1)])

    expect(plan.steps).toEqual([])
    expect(plan.rejected.map((rejection) => rejection.reason)).toEqual([
      'Точка вне скриншота.',
      'Точка вне скриншота.'
    ])
  })

  it('rejects a drag whose start is outside the frame', () => {
    const plan = normalize([
      step('Перетаскивание', {
        kind: 'drag',
        from: { x: 1.5, y: 0.5 },
        to: { x: 0.5, y: 0.5 }
      })
    ])

    expect(plan.rejected[0].reason).toBe('Точка вне скриншота.')
  })

  it('rejects a drag whose end is outside the frame', () => {
    const plan = normalize([
      step('Перетаскивание', {
        kind: 'drag',
        from: { x: 0.5, y: 0.5 },
        to: { x: 0.5, y: 2 }
      })
    ])

    expect(plan.rejected[0].reason).toBe('Точка вне скриншота.')
  })

  it('keeps a drag that is fully inside the frame', () => {
    const plan = normalize([
      step('Перетаскивание', {
        kind: 'drag',
        from: { x: 0.1, y: 0.1 },
        to: { x: 0.9, y: 0.9 }
      })
    ])

    expect(plan.steps).toHaveLength(1)
  })

  it('rejects a point when the captured area is degenerate', () => {
    const plan = normalizePlan([click(0.5, 0.5)], {
      settings,
      area: { x: 0, y: 0, width: 0, height: 900 }
    })

    expect(plan.steps).toEqual([])
  })

  it('keeps a point when there is no area to check against', () => {
    const plan = normalizePlan([click(0.5, 0.5)], { settings, area: null })

    expect(plan.steps).toHaveLength(1)
  })
})

describe('normalizePlan: @done and @look', () => {
  it('marks the plan finished and stops at @done', () => {
    const plan = normalize([click(0.1, 0.1), done(), click(0.2, 0.2)])

    expect(plan.finished).toBe(true)
    expect(plan.steps.map((entry) => entry.action.kind)).toEqual(['click', 'done'])
  })

  it('stops at @look and reports that a fresh frame is needed', () => {
    const plan = normalize([click(0.1, 0.1), look(), click(0.2, 0.2)])

    expect(plan.wantsLook).toBe(true)
    expect(plan.steps.map((entry) => entry.action.kind)).toEqual(['click'])
    // The look itself is not an action the runner may execute.
    expect(plan.steps.some((entry) => entry.action.kind === 'look')).toBe(false)
  })

  it('reports a look even when it is the first step', () => {
    const plan = normalize([look()])

    expect(plan.wantsLook).toBe(true)
    expect(plan.steps).toEqual([])
  })

  it('does not mark a plan without @done as finished', () => {
    expect(normalize([click(0.1, 0.1)]).finished).toBe(false)
  })

  it('keeps @done even when the step budget is already spent', () => {
    const raw = [...Array.from({ length: 6 }, () => click(0.1, 0.1)), done()]

    const plan = normalize(raw)

    expect(plan.finished).toBe(false)
    expect(plan.rejected).toHaveLength(1)
  })
})

describe('normalizePlan: pass-through', () => {
  it('keeps wait, scroll and move steps unchanged', () => {
    const raw = [
      step('Пауза', { kind: 'wait', ms: 400 }),
      step('Прокрутка', { kind: 'scroll', dx: 0, dy: -300 }),
      step('Наведение', { kind: 'move', at: { x: 0.5, y: 0.5 } })
    ]

    expect(normalize(raw).steps).toEqual(raw)
  })

  it('returns empty structures for an empty plan', () => {
    expect(normalize([])).toEqual({ steps: [], rejected: [], finished: false, wantsLook: false })
  })
})

describe('readVerdict', () => {
  const confirmed = normalize([done()])
  const unconfirmed = normalize([])
  const fix = normalize([click(0.3, 0.4)])

  it('confirms when the model says @done and proposes nothing', () => {
    expect(readVerdict(confirmed, { canFix: true })).toEqual({ kind: 'confirmed', actions: [] })
  })

  it('leaves a bare statement unconfirmed', () => {
    expect(readVerdict(unconfirmed, { canFix: true })).toEqual({
      kind: 'unconfirmed',
      actions: []
    })
  })

  it('treats actions as a fix while a correction is still possible', () => {
    const verdict = readVerdict(fix, { canFix: true })

    expect(verdict.kind).toBe('fix')
    expect(verdict.actions).toHaveLength(1)
  })

  it('refuses to trust @done that comes with actions', () => {
    // Actions first, then the claim: `@done` does not erase the work proposed
    // before it, so the answer is a fix with an opinion attached.
    const plan = normalize([click(0.3, 0.4), done()])
    const verdict = readVerdict(plan, { canFix: true })

    expect(verdict.kind).toBe('fix')
    expect(verdict.actions).toHaveLength(1)
    expect(verdict.actions.every((entry) => entry.action.kind !== 'done')).toBe(true)
  })

  it('ignores anything written after @done', () => {
    const plan = normalize([done(), click(0.3, 0.4)])

    expect(plan.steps).toHaveLength(1)
    expect(readVerdict(plan, { canFix: true })).toEqual({ kind: 'confirmed', actions: [] })
  })

  it('never returns @done among the actions', () => {
    const plan = normalize([click(0.3, 0.4), done()])

    expect(readVerdict(plan, { canFix: true }).actions.some((a) => a.action.kind === 'done')).toBe(
      false
    )
  })

  it('turns actions into "unconfirmed" when no correction is possible', () => {
    expect(readVerdict(fix, { canFix: false })).toEqual({ kind: 'unconfirmed', actions: [] })
  })

  it('still confirms on the last look when the model only says @done', () => {
    expect(readVerdict(confirmed, { canFix: false }).kind).toBe('confirmed')
  })

  it('leaves a bare statement unconfirmed on the last look', () => {
    expect(readVerdict(unconfirmed, { canFix: false }).kind).toBe('unconfirmed')
  })
})
