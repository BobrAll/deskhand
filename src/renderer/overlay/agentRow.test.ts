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
import { actionCount, agentLabel, agentMark, agentSummary } from './agentRow'

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

describe('agentSummary', () => {
  it('counts the steps of a successful run', () => {
    expect(agentSummary(event({
      phase: 'done', completed: true, step: 2,
      actions: [
        { tool: 'click', label: 'Нажал', ok: true },
        { tool: 'click', label: 'Нажал', ok: true }
      ]
    }))).toBe('Готово · 2 шага')
  })

  it('does not call a run finished just because the phase is done', () => {
    expect(agentSummary(event({ phase: 'done', completed: false, message: 'Не дошёл.' })))
      .toBe('Не дошёл. · 1 шаг')
  })

  it('has a count when a failed run has no message of its own', () => {
    expect(agentSummary(event({
      phase: 'done', completed: false, actions: [{ tool: 'click', label: 'Нажал', ok: false }]
    }))).toBe('Задача осталась невыполненной · 1 шаг')
  })

  it('summarises an aborted run with its steps and history count', () => {
    expect(agentSummary(event({
      phase: 'aborted', step: 2, message: 'Остановлено: ты взял мышь.',
      actions: [{ tool: 'click', label: 'Нажал', ok: true }]
    }))).toBe('Остановлено: ты взял мышь. · 2 шага')
  })

  it('uses the agent step number rather than the call count', () => {
    expect(agentSummary(event({
      phase: 'done', completed: true, step: 1,
      actions: [
        { tool: 'click', label: 'Нажал', ok: true },
        { tool: 'click', label: 'Нажал', ok: true }
      ]
    }))).toBe('Готово · 1 шаг')
  })

  it('says nothing while the run is still going', () => {
    expect(agentSummary(event({ phase: 'acting' }))).toBeNull()
  })
})

describe('actionCount', () => {
  it('declines the noun for the numbers a run actually produces', () => {
    expect(actionCount(1)).toBe('1 шаг')
    expect(actionCount(2)).toBe('2 шага')
    expect(actionCount(4)).toBe('4 шага')
    expect(actionCount(5)).toBe('5 шагов')
    expect(actionCount(11)).toBe('11 шагов')
    expect(actionCount(21)).toBe('21 шаг')
    expect(actionCount(22)).toBe('22 шага')
    expect(actionCount(25)).toBe('25 шагов')
  })
})
