/**
 * What each key press means.
 *
 * The cases are chosen by what differs on screen, not by branch coverage: every
 * one of these either closes a card the user was reading, or leaves one open they
 * wanted gone. Both are silent failures — no exception, no log, just a card that
 * did the wrong thing at the moment someone was watching the screen instead of the
 * card.
 */

import { describe, expect, it } from 'vitest'
import { keyPolicy, type KeyInput } from './keyPolicy'

/** A key press on an idle card with an answer on it and nothing selected. */
function key(overrides: Partial<KeyInput> = {}): KeyInput {
  return {
    key: 'a',
    meta: false,
    shift: false,
    tagName: 'TEXTAREA',
    agentPhase: null,
    busy: false,
    runActive: false,
    hasSelection: false,
    hasAnswer: true,
    ...overrides
  }
}

describe('keyPolicy: Escape while a run owns the card', () => {
  it('refuses the question while the run is waiting for an answer', () => {
    // The agent is blocked on this answer, so Escape has to *be* an answer. If it
    // closed the card instead, the run would stay blocked on a question that is
    // no longer on screen — the one state the card must never reach.
    expect(keyPolicy(key({ key: 'Escape', agentPhase: 'asking' }))).toBe('deny')
  })

  it('stops the run while it is arming or acting', () => {
    expect(keyPolicy(key({ key: 'Escape', agentPhase: 'arming' }))).toBe('stopAgent')
    expect(keyPolicy(key({ key: 'Escape', agentPhase: 'acting' }))).toBe('stopAgent')
  })

  it('closes once the run is over', () => {
    for (const phase of ['idle', 'done', 'aborted', 'error'] as const) {
      expect(keyPolicy(key({ key: 'Escape', agentPhase: phase })), phase).toBe('close')
    }
  })

  it('closes a card with no run on it', () => {
    expect(keyPolicy(key({ key: 'Escape', agentPhase: null }))).toBe('close')
  })

  it('stops a running answer without closing the card', () => {
    expect(keyPolicy(key({ key: 'Escape', busy: true }))).toBe('cancel')
  })

  it('stops a run whose phase is already aborted but is still on screen', () => {
    expect(keyPolicy(key({ key: 'Escape', busy: true, runActive: true, agentPhase: 'aborted' })))
      .toBe('stopAgent')
  })
})

describe('keyPolicy: the question in the card', () => {
  it('approves with Enter and remembers with Command+Enter', () => {
    expect(keyPolicy(key({ key: 'Enter', agentPhase: 'asking', tagName: 'BODY' }))).toBe('approve')
    expect(keyPolicy(key({ key: 'Enter', agentPhase: 'asking', meta: true, tagName: 'BODY' })))
      .toBe('approveAlways')
  })

  it('leaves Enter to a focused approval button', () => {
    // Otherwise tabbing to «Отменить» and pressing Enter would approve instead.
    expect(keyPolicy(key({ key: 'Enter', agentPhase: 'asking', tagName: 'BUTTON' }))).toBeNull()
  })

  it('refuses the question with Escape', () => {
    expect(keyPolicy(key({ key: 'Escape', agentPhase: 'asking' }))).toBe('deny')
  })

  it('does not send from a textarea that happens to be under the question', () => {
    expect(keyPolicy(key({ key: 'Enter', agentPhase: 'asking', tagName: 'TEXTAREA' }))).toBeNull()
  })

  it('still remembers with Command+Enter when a button has focus', () => {
    expect(keyPolicy(key({ key: 'Enter', agentPhase: 'asking', meta: true, tagName: 'BUTTON' })))
      .toBe('approveAlways')
  })
})

describe('keyPolicy: ⌘C', () => {
  it('copies the answer when nothing is selected', () => {
    expect(keyPolicy(key({ key: 'c', meta: true, hasSelection: false }))).toBe('copy')
  })

  it('leaves a real selection to the browser', () => {
    // The user highlighted part of the answer; copying the whole thing instead is
    // the one outcome they definitely did not ask for.
    expect(keyPolicy(key({ key: 'c', meta: true, hasSelection: true }))).toBeNull()
  })

  it('does nothing with no answer to copy', () => {
    expect(keyPolicy(key({ key: 'c', meta: true, hasAnswer: false }))).toBeNull()
  })

  it('accepts the upper-case form the key event reports with Shift', () => {
    expect(keyPolicy(key({ key: 'C', meta: true, shift: true }))).toBe('copy')
  })

  it('does not fire on a plain c', () => {
    expect(keyPolicy(key({ key: 'c', meta: false }))).toBeNull()
  })
})

describe('keyPolicy: Enter', () => {
  it('sends from the field', () => {
    expect(keyPolicy(key({ key: 'Enter', tagName: 'TEXTAREA' }))).toBe('send')
  })

  it('does nothing from anywhere else', () => {
    // The card is not a form: a stray Enter over a button must not fire a request.
    expect(keyPolicy(key({ key: 'Enter', tagName: 'BUTTON' }))).toBeNull()
    expect(keyPolicy(key({ key: 'Enter', tagName: 'DIV' }))).toBeNull()
    expect(keyPolicy(key({ key: 'Enter', tagName: null }))).toBeNull()
  })

  it('lets Shift+Enter be a newline', () => {
    expect(keyPolicy(key({ key: 'Enter', shift: true }))).toBeNull()
  })

})

describe('keyPolicy: everything else', () => {
  it('leaves an ordinary letter alone', () => {
    expect(keyPolicy(key({ key: 'ш' }))).toBeNull()
    expect(keyPolicy(key({ key: 'Tab' }))).toBeNull()
    expect(keyPolicy(key({ key: 'ArrowDown' }))).toBeNull()
  })

  it('leaves ⌘A to the browser', () => {
    expect(keyPolicy(key({ key: 'a', meta: true }))).toBeNull()
  })
})
