import { describe, expect, it } from 'vitest'
import { modifierHold } from './modifierHold'

describe('modifierHold: the accelerator a modifier-only hold commits', () => {
  it('recovers Fn from the keyup when it never sent its own keydown', () => {
    expect(modifierHold(['Control'], ['Control', 'Fn'])).toBe('Control+Fn')
  })

  it('keeps the full held set when the last keyup reports only part of it', () => {
    expect(modifierHold(['Control', 'Alt'], ['Alt'])).toBe('Control+Alt')
  })

  it('rejects one modifier, which would fire on ordinary typing', () => {
    expect(modifierHold(['Control'], ['Control'])).toBeNull()
    expect(modifierHold([], ['Fn'])).toBeNull()
  })

  it('deduplicates the two sources', () => {
    expect(modifierHold(['Control', 'Control'], ['Control', 'Alt'])).toBe('Control+Alt')
  })
})
