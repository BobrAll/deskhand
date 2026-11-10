/**
 * The agent row, as the card draws it.
 *
 * The case that matters is the one a user hit: a task that was never finished
 * ended with a green checkmark, because the run's phase was `done` and the phase
 * alone was what the card looked at. These cases pin the distinction between
 * "ended" and "succeeded".
 */

import { describe, expect, it } from 'vitest'
import type { AgentEvent } from '@shared/types'
import { agentLabel, agentMark } from './agentRow'

function event(overrides: Partial<AgentEvent> = {}): AgentEvent {
  return { phase: 'acting', step: 1, total: 3, label: '', ...overrides }
}

describe('the agent row’s mark', () => {
  it('draws the checkmark only when the task was done', () => {
    expect(agentMark(event({ phase: 'done', completed: true }))).toBe('done')
  })

  it('does not draw a checkmark over a run that ran out of steps', () => {
    // This is the bug: the agent ends the run with `done` whether or not it
    // finished, so the phase alone cannot be the signal.
    expect(agentMark(event({ phase: 'done', completed: false }))).toBe('failed')
  })

  it('does not draw a checkmark for a run that stopped for any other reason', () => {
    expect(agentMark(event({ phase: 'error' }))).toBe('progress')
    expect(agentMark(event({ phase: 'aborted' }))).toBe('progress')
    expect(agentMark(event({ phase: 'asking' }))).toBe('progress')
  })
})

describe('the agent row’s label', () => {
  it('says what happened when the task was not finished', () => {
    const label = agentLabel(event({
      phase: 'done',
      completed: false,
      message: 'Не успел за 3 шага — задача осталась невыполненной.'
    }))

    expect(label).toContain('Не успел')
  })

  it('never falls back to "Готово" on a failed run', () => {
    // The dangerous fallback: an empty label on an incomplete run used to render
    // the success word, so the card said "Готово" over a task nobody did.
    const label = agentLabel(event({ phase: 'done', completed: false }))

    expect(label).not.toBe('Готово')
    expect(label).toBe('Задача осталась невыполненной')
  })

  it('leaves the closing sentence to the answer', () => {
    expect(agentLabel(event({ phase: 'done', completed: true, label: 'Сообщение отправлено.' })))
      .toBeNull()
  })

  it('shows a short startup label', () => {
    expect(agentLabel(event({ phase: 'arming' }))).toBe('Подготовка')
  })

  it('shows the current action after earlier steps have finished', () => {
    const actions = [{ tool: 'click', label: 'Нажимаю', ok: true }]
    expect(agentLabel(event({ actions, label: 'Печатаю текст' }))).toBe('Печатаю текст')
    expect(agentLabel(event({ actions }))).toBe('Работаю…')
  })

  it('leaves a repeated terminal message in the answer only', () => {
    const message = 'Остановлено: ты взял мышь.'
    const aborted = event({ phase: 'aborted', message })
    expect(agentLabel(aborted, ` ${message} `)).toBeNull()
    expect(agentLabel(aborted, 'Другой ответ')).toBe(message)
  })

  it('shows the stop reason on an aborted run', () => {
    expect(agentLabel(event({ phase: 'aborted', message: 'Остановлено: ты взял мышь.' })))
      .toBe('Остановлено: ты взял мышь.')
  })
})
