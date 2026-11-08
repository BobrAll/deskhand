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
import { agentLabel, agentMark, agentShowsCount } from './agentRow'

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

  it('keeps the agent’s own closing sentence when the run did finish', () => {
    expect(agentLabel(event({ phase: 'done', completed: true, label: 'Сообщение отправлено.' })))
      .toBe('Сообщение отправлено.')
  })

  it('says "Готово" for a finished run with nothing to add', () => {
    expect(agentLabel(event({ phase: 'done', completed: true }))).toBe('Готово')
  })

  it('warns about Escape before the first call', () => {
    expect(agentLabel(event({ phase: 'arming' }))).toContain('Escape')
  })

  it('shows the stop reason on an aborted run', () => {
    expect(agentLabel(event({ phase: 'aborted', message: 'Остановлено: вы взяли мышь.' })))
      .toBe('Остановлено: вы взяли мышь.')
  })
})

describe('the agent row’s step counter', () => {
  it('counts while the agent is working', () => {
    expect(agentShowsCount(event({ phase: 'acting', step: 2, total: 3 }))).toBe(true)
  })

  it('counts while a question is open, because the run is still going', () => {
    expect(agentShowsCount(event({ phase: 'asking', step: 2, total: 3 }))).toBe(true)
  })

  it('stops counting once the run is over', () => {
    // "3/3" after a failure reads as a completion badge.
    expect(agentShowsCount(event({ phase: 'done', completed: false, step: 3, total: 3 }))).toBe(false)
    expect(agentShowsCount(event({ phase: 'done', completed: true }))).toBe(false)
  })
})
