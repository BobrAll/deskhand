import { describe, expect, it } from 'vitest'

import { FUNCTION_CODES, KEY_CODES, VOICE_KEY_CODES } from './keycodes'

/**
 * The two parsers share the numbers but not the grammar. These tests exist to
 * keep that line where it is: the sizes are pinned, and the voice table is
 * checked to be the agent table minus exactly two aliases.
 *
 * Why it matters: `parseShortcut` (voice) accepts a single bare key, while
 * `parseAccelerator` (agent) requires a modifier. Letting `esc` into the voice
 * table would turn "esc" from a validation error into a registerable global
 * hotkey — a behaviour change nobody asked for.
 */

describe('keycodes: the shared tables', () => {
  it('keeps the agent table at 64 entries', () => {
    expect(Object.keys(KEY_CODES)).toHaveLength(64)
  })

  it('keeps the voice table at 62 entries', () => {
    expect(Object.keys(VOICE_KEY_CODES)).toHaveLength(62)
  })

  it('keeps F1–F20 identical and complete for both parsers', () => {
    expect(Object.keys(FUNCTION_CODES)).toHaveLength(20)
    expect(FUNCTION_CODES[1]).toBe(122)
    expect(FUNCTION_CODES[20]).toBe(90)
  })

  it('gives every voice key the same code as the agent table', () => {
    for (const [name, code] of Object.entries(VOICE_KEY_CODES)) {
      expect(KEY_CODES[name], name).toBe(code)
    }
  })

  it('holds the two aliases that the voice parser must not see', () => {
    expect(KEY_CODES.esc).toBe(53)
    expect(KEY_CODES.forwarddelete).toBe(117)
    expect(VOICE_KEY_CODES.esc).toBeUndefined()
    expect(VOICE_KEY_CODES.forwarddelete).toBeUndefined()
  })

  it('still lets the voice parser use the long spellings of both', () => {
    expect(VOICE_KEY_CODES.escape).toBe(53)
    expect(VOICE_KEY_CODES.delete).toBe(117)
  })

  it('is exactly the agent table minus those two names', () => {
    const extra = Object.keys(KEY_CODES).filter((name) => !(name in VOICE_KEY_CODES))
    expect(extra.sort()).toEqual(['esc', 'forwarddelete'])
  })

  it('keeps the hardware codes the helper expects', () => {
    expect(KEY_CODES.a).toBe(0)
    expect(KEY_CODES.s).toBe(1)
    expect(KEY_CODES.return).toBe(36)
    expect(KEY_CODES.enter).toBe(36)
    expect(KEY_CODES.space).toBe(49)
    expect(KEY_CODES.tab).toBe(48)
    expect(KEY_CODES['0']).toBe(29)
    expect(KEY_CODES['9']).toBe(25)
    expect(KEY_CODES['/']).toBe(44)
    expect(KEY_CODES['\\']).toBe(42)
  })
})
