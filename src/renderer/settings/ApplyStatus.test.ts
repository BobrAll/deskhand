/**
 * What the settings footer says.
 *
 * The wording is the whole feature: the window has no save button, so this line is
 * the only thing that tells the user whether their last keystroke reached the disk.
 * Two cases are load-bearing — `idle` must be silent (a permanent "Применено"
 * trains people to stop reading it) and `held` must print the *reason* (the
 * generic "не применено" over a half-typed token count reads as a failure).
 */

import { describe, expect, it } from 'vitest'
import { applyStatusText } from './ApplyStatus'

describe('applyStatusText: silence when there is nothing to say', () => {
  it('says nothing at rest', () => {
    expect(applyStatusText('idle', null)).toBeNull()
  })

  it('says nothing at rest even with a reason lying around', () => {
    expect(applyStatusText('idle', 'Максимум токенов: от 64 до 8192.')).toBeNull()
  })
})

describe('applyStatusText: on the way to disk', () => {
  it('distinguishes waiting from writing', () => {
    expect(applyStatusText('pending', null)).toEqual({ text: 'Применяю…', isProblem: false })
    expect(applyStatusText('saving', null)).toEqual({ text: 'Сохраняю…', isProblem: false })
  })

  it('confirms the write', () => {
    expect(applyStatusText('saved', null)).toEqual({ text: 'Применено', isProblem: false })
  })
})

describe('applyStatusText: a write that did not happen', () => {
  it('prints the reason when the settings refused the value', () => {
    expect(applyStatusText('held', 'Пустой системный промпт оставлен прежним.')).toEqual({
      text: 'Пустой системный промпт оставлен прежним.',
      isProblem: true
    })
  })

  it('falls back to a plain sentence when there is no reason', () => {
    expect(applyStatusText('held', null)).toEqual({ text: 'Изменения не применены', isProblem: true })
  })

  it('reports a failed write without pretending to know why', () => {
    expect(applyStatusText('error', null)).toEqual({
      text: 'Не применено — попробуй ещё раз',
      isProblem: true
    })
  })

  it('marks both unhappy states as problems', () => {
    // The colour is the only difference between "не сохранено" and "сохранено"
    // for someone glancing at the footer.
    expect(applyStatusText('held', 'x')?.isProblem).toBe(true)
    expect(applyStatusText('error', null)?.isProblem).toBe(true)
    expect(applyStatusText('saved', null)?.isProblem).toBe(false)
  })
})
