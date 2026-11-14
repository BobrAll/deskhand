/**
 * What a press means to the hotkey recorder.
 *
 * The recorder's rules were checked by pressing keys at the window: a bare letter
 * must not become a shortcut, a digit must not be confused with a function key, a
 * held modifier pair is only a gesture for the voice fields, and the accelerator
 * always spells its modifiers in Electron's order. None of that needs a DOM.
 */

import { describe, expect, it } from 'vitest'
import { isModifierKey, keyFromEvent, modifierParts, toAccelerator } from './hotkeyCapture'

interface Modifiers {
  meta?: boolean
  ctrl?: boolean
  alt?: boolean
  shift?: boolean
  fn?: boolean
}

/** The parts of a KeyboardEvent the recorder reads. */
function press(code: string, modifiers: Modifiers = {}): KeyboardEvent {
  return {
    code,
    metaKey: modifiers.meta === true,
    ctrlKey: modifiers.ctrl === true,
    altKey: modifiers.alt === true,
    shiftKey: modifiers.shift === true,
    getModifierState: (name: string) => name === 'Fn' && modifiers.fn === true
  } as unknown as KeyboardEvent
}

describe('keyFromEvent: the physical key', () => {
  it('names letters and digits by their code', () => {
    expect(keyFromEvent(press('KeyK'))).toBe('K')
    expect(keyFromEvent(press('Digit5'))).toBe('5')
  })

  it('names function keys as they are', () => {
    expect(keyFromEvent(press('F5'))).toBe('F5')
  })

  it('translates punctuation and navigation keys', () => {
    expect(keyFromEvent(press('BracketLeft'))).toBe('[')
    expect(keyFromEvent(press('ArrowUp'))).toBe('Up')
    expect(keyFromEvent(press('Space'))).toBe('Space')
  })

  it('gives up on a key the accelerator cannot name', () => {
    expect(keyFromEvent(press('IntlBackslash'))).toBeNull()
  })
})

describe('modifierParts: what was held', () => {
  it('spells the modifiers in the accelerator order', () => {
    expect(modifierParts(press('KeyK', { shift: true, alt: true, ctrl: true, meta: true }), false))
      .toEqual(['Command', 'Control', 'Alt', 'Shift'])
  })

  it('keeps Fn only where the field accepts modifier holds', () => {
    expect(modifierParts(press('KeyK', { fn: true }), false)).toEqual([])
    expect(modifierParts(press('KeyK', { fn: true }), true)).toEqual(['Fn'])
  })

  it('is empty for a plain key', () => {
    expect(modifierParts(press('KeyK'), true)).toEqual([])
  })
})

describe('toAccelerator: the recorded shortcut', () => {
  it('records a letter with its modifiers', () => {
    expect(toAccelerator(press('KeyK', { meta: true }), false)).toBe('Command+K')
  })

  it('records punctuation and the modifier order', () => {
    expect(toAccelerator(press('BracketLeft', { meta: true, shift: true }), false))
      .toBe('Command+Shift+[')
  })

  it('refuses a bare key, so ordinary typing never becomes a shortcut', () => {
    expect(toAccelerator(press('KeyK'), false)).toBeNull()
    expect(toAccelerator(press('Digit5'), true)).toBeNull()
  })

  it('refuses a key it cannot name even when a modifier is held', () => {
    expect(toAccelerator(press('IntlBackslash', { meta: true }), false)).toBeNull()
  })

  it('accepts Fn only where modifier holds are allowed', () => {
    expect(toAccelerator(press('KeyK', { fn: true }), false)).toBeNull()
    expect(toAccelerator(press('KeyK', { fn: true }), true)).toBe('Fn+K')
  })
})

describe('isModifierKey', () => {
  it('recognises the keys whose own press is not the shortcut', () => {
    for (const key of ['Meta', 'Control', 'Alt', 'Shift', 'CapsLock', 'Fn']) {
      expect(isModifierKey(key), key).toBe(true)
    }
    expect(isModifierKey('K')).toBe(false)
  })
})
