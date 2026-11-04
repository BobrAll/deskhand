/**
 * What each key press means.
 *
 * The cases are chosen by what differs on screen, not by branch coverage: every
 * one of these either closes a card the user was reading, or leaves one open they
 * wanted gone. Both are silent failures — no exception, no log, just a card that
 * did the wrong thing at the moment someone was watching the screen instead of the
 * bubble.
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
    hasRequestId: false,
    hasSelection: false,
    hasAnswer: true,
    ...overrides
  }
}

describe('keyPolicy: Escape while a run owns the card', () => {
  it('cancels the request while the result is being checked', () => {
    // Nothing is moving during a check, so there is no run to stop — the request
    // in flight is the thing that has to be cancelled.
    expect(keyPolicy(key({ key: 'Escape', agentPhase: 'checking', hasRequestId: true }))).toBe('cancel')
  })

  it('closes when it is checking but there is no request to cancel', () => {
    expect(keyPolicy(key({ key: 'Escape', agentPhase: 'checking', hasRequestId: false }))).toBe('close')
  })

  it('stops the run while a plan is arming or acting', () => {
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
})

describe('keyPolicy: ⌘⏎', () => {
  it('pastes the answer', () => {
    expect(keyPolicy(key({ key: 'Enter', meta: true }))).toBe('paste')
  })

  it('does not paste without the modifier', () => {
    expect(keyPolicy(key({ key: 'Enter', meta: false }))).toBe('send')
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

  it('lets Ctrl+Enter reach the paste branch instead of sending', () => {
    expect(keyPolicy(key({ key: 'Enter', meta: true, shift: false }))).toBe('paste')
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
