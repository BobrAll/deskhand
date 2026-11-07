import { describe, expect, it } from 'vitest'

import type { AgentPlanStep } from '@shared/types'
import { normalizeLabel, readError, readResult, semanticFor } from './semantic'
import type { CuActionResult } from './computerUse'

function step(action: AgentPlanStep['action'], label = 'шаг'): AgentPlanStep {
  return { action, label }
}

function click(label: string | undefined, button: AgentPlanStep['action'] extends never ? never : 'left' | 'right' | 'double' = 'left'): AgentPlanStep {
  return step({ kind: 'click', at: { x: 0.5, y: 0.5 }, button, label })
}

function result(overrides: Partial<CuActionResult> = {}): CuActionResult {
  return {
    outcome: 'verified',
    verified: true,
    actionId: 'a1',
    target: 'AXButton:Сохранить',
    strategy: 'ariaLabel',
    confidence: 1,
    attempts: 1,
    durationMs: 40,
    dispatcher: 'AXSemantic',
    notifications: ['AXValueChanged'],
    cursorMoved: false,
    frontmostChanged: false,
    notes: [],
    ...overrides
  }
}

describe('normalizeLabel', () => {
  it('strips the quotes the protocol wraps labels in', () => {
    expect(normalizeLabel('«Экспорт»')).toBe('Экспорт')
    expect(normalizeLabel('"Save"')).toBe('Save')
  })

  it('collapses whitespace so a wrapped label still matches', () => {
    expect(normalizeLabel('  Save   as…  ')).toBe('Save as…')
  })

  it('rejects a label too short to be a name', () => {
    // One character is a letter on a keyboard, not a control worth naming.
    expect(normalizeLabel('X')).toBeNull()
    expect(normalizeLabel('  ')).toBeNull()
    expect(normalizeLabel(undefined)).toBeNull()
  })
})

describe('semanticFor', () => {
  it('turns a labelled click into a press on that name', () => {
    expect(semanticFor(click('Экспорт'))).toEqual({
      query: { text: 'Экспорт' },
      action: { kind: 'press' },
      label: 'Нажатие: «Экспорт»'
    })
  })

  it('prefers focus over press when the aimed element is a text field', () => {
    // Pressing a text field is not what clicking it does; focusing it is.
    const request = semanticFor(click('Поиск'), { element: { role: 'AXTextField' } })
    expect(request?.action).toEqual({ kind: 'focus' })
  })

  it('treats an editable element as a field even without a field role', () => {
    const request = semanticFor(click('Запрос'), { element: { editable: true } })
    expect(request?.action).toEqual({ kind: 'focus' })
  })

  it('declines a click with no name', () => {
    // Without a label there is nothing to look up; the pixel is all there is.
    expect(semanticFor(click(undefined))).toBeNull()
  })

  it('declines a double click, which has no semantic equivalent', () => {
    expect(semanticFor(click('Документ', 'double'))).toBeNull()
  })

  it('routes typing to the field the previous step named', () => {
    const previous = click('Поиск')
    const request = semanticFor(step({ kind: 'type', text: 'погода' }), { previous })
    expect(request).toEqual({
      query: { text: 'Поиск' },
      action: { kind: 'typeText', text: 'погода' },
      label: 'Ввод в «Поиск»'
    })
  })

  it('declines typing when the previous step named no field', () => {
    // Typing with nothing to aim at would be "whatever has focus", which is the
    // situation the semantic path exists to avoid rather than to reproduce.
    expect(semanticFor(step({ kind: 'type', text: 'текст' }), {})).toBeNull()
    expect(semanticFor(step({ kind: 'type', text: 'текст' }), { previous: step({ kind: 'wait', ms: 10 }) })).toBeNull()
  })

  it('has no semantic version for gestures with no named control', () => {
    expect(semanticFor(step({ kind: 'scroll', dx: 0, dy: -200 }))).toBeNull()
    expect(semanticFor(step({ kind: 'key', combo: 'cmd+s' }))).toBeNull()
    expect(semanticFor(step({ kind: 'drag', from: { x: 0, y: 0 }, to: { x: 1, y: 1 } }))).toBeNull()
    expect(semanticFor(step({ kind: 'navigate', url: 'https://example.com' }))).toBeNull()
  })
})

describe('readResult', () => {
  it('treats a verified action as done and never retries it', () => {
    expect(readResult(result({ outcome: 'verified' }))).toEqual({ kind: 'done', verified: true })
    expect(readResult(result({ outcome: 'verifiedAfterRetry' }))).toEqual({ kind: 'done', verified: true })
  })

  it('treats an unobserved change as done, not as a failure', () => {
    // The call succeeded and the app announced nothing. Repeating it as a click
    // would press the button twice, which is worse than not proving it happened.
    expect(readResult(result({ outcome: 'performedUnverified', verified: false })))
      .toEqual({ kind: 'done', verified: false })
  })

  it('falls back when nothing was performed', () => {
    for (const outcome of ['refused', 'failed', 'elementVanished']) {
      expect(readResult(result({ outcome }))).toEqual({ kind: 'fallback', reason: outcome })
    }
  })
})

describe('readError', () => {
  it('falls back on a missing service', () => {
    const error = Object.assign(new Error('no socket'), { reason: 'missing' })
    expect(readError(error)).toEqual({ kind: 'fallback', reason: 'missing', uncertain: false })
  })

  it('marks a timeout as uncertain, because the action may have been delivered', () => {
    const error = Object.assign(new Error('timeout'), { reason: 'timeout' })
    expect(readError(error).uncertain).toBe(true)
  })

  it('reports an RPC refusal by its code', () => {
    const error = Object.assign(new Error('ambiguous'), { code: -32003 })
    expect(readError(error)).toEqual({ kind: 'fallback', reason: 'rpc--32003', uncertain: false })
  })

  it('falls back on an unrecognised throw rather than assuming success', () => {
    expect(readError(new Error('boom'))).toEqual({ kind: 'fallback', reason: 'unknown', uncertain: false })
  })
})
