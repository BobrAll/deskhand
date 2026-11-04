import { describe, expect, it } from 'vitest'

import { describeShortcut, parseShortcut } from './keys'

const CMD = 0x00100000
const SHIFT = 0x00020000
const CTRL = 0x00040000
const ALT = 0x00080000

describe('parseShortcut: modifiers', () => {
  it('parses the canonical form', () => {
    expect(parseShortcut('cmd+s')).toEqual({ keyCode: 1, flags: CMD })
  })

  it('accepts every alias of each modifier', () => {
    for (const name of ['cmd', 'command', 'meta', 'super']) {
      expect(parseShortcut(`${name}+s`), name).toEqual({ keyCode: 1, flags: CMD })
    }
    for (const name of ['ctrl', 'control']) {
      expect(parseShortcut(`${name}+s`), name).toEqual({ keyCode: 1, flags: CTRL })
    }
    for (const name of ['alt', 'opt', 'option']) {
      expect(parseShortcut(`${name}+s`), name).toEqual({ keyCode: 1, flags: ALT })
    }
    expect(parseShortcut('shift+s')).toEqual({ keyCode: 1, flags: SHIFT })
  })

  it('accepts the Apple symbols and uppercased input', () => {
    expect(parseShortcut('⌘S')).toEqual({ keyCode: 1, flags: CMD })
    expect(parseShortcut('⌘⇧S')).toEqual({ keyCode: 1, flags: CMD | SHIFT })
    expect(parseShortcut('⌥⌃S')).toEqual({ keyCode: 1, flags: ALT | CTRL })
    expect(parseShortcut('CMD+S')).toEqual({ keyCode: 1, flags: CMD })
  })

  it('tolerates spaces, dashes and underscores as separators', () => {
    expect(parseShortcut('Cmd + S')).toEqual({ keyCode: 1, flags: CMD })
    expect(parseShortcut('cmd-shift-s')).toEqual({ keyCode: 1, flags: CMD | SHIFT })
    expect(parseShortcut('cmd_shift_s')).toEqual({ keyCode: 1, flags: CMD | SHIFT })
    expect(parseShortcut('  cmd+s  ')).toEqual({ keyCode: 1, flags: CMD })
  })

  it('ORs modifiers together in any order', () => {
    const expected = { keyCode: 48, flags: CTRL | ALT | SHIFT | CMD }
    expect(parseShortcut('cmd+shift+alt+ctrl+tab')).toEqual(expected)
    expect(parseShortcut('ctrl+alt+shift+cmd+tab')).toEqual(expected)
  })

  it('rejects a shortcut made only of modifiers', () => {
    expect(parseShortcut('cmd+shift')).toBeNull()
    expect(parseShortcut('cmd')).toBeNull()
  })
})

describe('parseShortcut: keys', () => {
  it('parses named keys', () => {
    expect(parseShortcut('enter')).toEqual({ keyCode: 36, flags: 0 })
    expect(parseShortcut('return')).toEqual({ keyCode: 36, flags: 0 })
    expect(parseShortcut('esc')).toEqual({ keyCode: 53, flags: 0 })
    expect(parseShortcut('escape')).toEqual({ keyCode: 53, flags: 0 })
    expect(parseShortcut('tab')).toEqual({ keyCode: 48, flags: 0 })
    expect(parseShortcut('space')).toEqual({ keyCode: 49, flags: 0 })
    expect(parseShortcut('backspace')).toEqual({ keyCode: 51, flags: 0 })
    expect(parseShortcut('delete')).toEqual({ keyCode: 117, flags: 0 })
    expect(parseShortcut('forwarddelete')).toEqual({ keyCode: 117, flags: 0 })
    expect(parseShortcut('up')).toEqual({ keyCode: 126, flags: 0 })
    expect(parseShortcut('down')).toEqual({ keyCode: 125, flags: 0 })
    expect(parseShortcut('left')).toEqual({ keyCode: 123, flags: 0 })
    expect(parseShortcut('right')).toEqual({ keyCode: 124, flags: 0 })
    expect(parseShortcut('pageup')).toEqual({ keyCode: 116, flags: 0 })
    expect(parseShortcut('pagedown')).toEqual({ keyCode: 121, flags: 0 })
    expect(parseShortcut('home')).toEqual({ keyCode: 115, flags: 0 })
    expect(parseShortcut('end')).toEqual({ keyCode: 119, flags: 0 })
  })

  it('parses every letter and digit to its hardware code', () => {
    const letters: Record<string, number> = {
      a: 0, s: 1, d: 2, f: 3, h: 4, g: 5, z: 6, x: 7, c: 8, v: 9,
      b: 11, q: 12, w: 13, e: 14, r: 15, y: 16, t: 17, o: 31, u: 32,
      i: 34, p: 35, l: 37, j: 38, k: 40, n: 45, m: 46
    }
    for (const [letter, code] of Object.entries(letters)) {
      expect(parseShortcut(letter), letter).toEqual({ keyCode: code, flags: 0 })
    }
    // Digits are not in numeric order: these are the hardware codes.
    const digits: Record<string, number> = {
      '0': 29, '1': 18, '2': 19, '3': 20, '4': 21,
      '5': 23, '6': 22, '7': 26, '8': 28, '9': 25
    }
    for (const [digit, code] of Object.entries(digits)) {
      expect(parseShortcut(digit), digit).toEqual({ keyCode: code, flags: 0 })
    }
  })

  it('parses punctuation', () => {
    const punctuation: Record<string, number> = {
      ',': 43, '.': 47, '/': 44, ';': 41, "'": 39,
      '[': 33, ']': 30, '\\': 42, '=': 24, '`': 50
    }
    for (const [char, code] of Object.entries(punctuation)) {
      expect(parseShortcut(char), char).toEqual({ keyCode: code, flags: 0 })
    }
  })

  it('parses F1-F20 through their own table', () => {
    expect(parseShortcut('f1')).toEqual({ keyCode: 122, flags: 0 })
    expect(parseShortcut('f5')).toEqual({ keyCode: 96, flags: 0 })
    expect(parseShortcut('f12')).toEqual({ keyCode: 111, flags: 0 })
    expect(parseShortcut('f20')).toEqual({ keyCode: 90, flags: 0 })
    expect(parseShortcut('F1')).toEqual({ keyCode: 122, flags: 0 })
  })

  it('rejects function keys outside the table', () => {
    expect(parseShortcut('f0')).toBeNull()
    expect(parseShortcut('f21')).toBeNull()
    expect(parseShortcut('f100')).toBeNull()
  })
})

describe('parseShortcut: what is not a shortcut', () => {
  it('rejects empty input', () => {
    expect(parseShortcut('')).toBeNull()
    expect(parseShortcut('   ')).toBeNull()
  })

  it('rejects a second non-modifier key', () => {
    expect(parseShortcut('a+b')).toBeNull()
    expect(parseShortcut('cmd+s+t')).toBeNull()
    expect(parseShortcut('enter+tab')).toBeNull()
  })

  it('rejects an unknown key name', () => {
    expect(parseShortcut('cmd+foo')).toBeNull()
    expect(parseShortcut('hyper+s')).toBeNull()
    expect(parseShortcut('ж')).toBeNull()
  })

  it('rejects a shortcut whose only key is the `-` separator (KNOWN BUG: characterization)', () => {
    // `-` is both a key and a separator, so the separator pass eats it first.
    // Nothing in a plan writes a bare minus, so this is left as it is.
    expect(parseShortcut('-')).toBeNull()
    expect(parseShortcut('cmd+-')).toBeNull()
  })
})

describe('describeShortcut: how a shortcut is shown in the card', () => {
  it('prints modifiers as Apple symbols in ⌃⌥⇧⌘ order', () => {
    expect(describeShortcut('cmd+s')).toBe('⌘S')
    expect(describeShortcut('cmd+shift+s')).toBe('⇧⌘S')
    expect(describeShortcut('ctrl+alt+shift+cmd+s')).toBe('⌃⌥⇧⌘S')
    expect(describeShortcut('alt+tab')).toBe('⌥Tab')
  })

  it('prefers the name a person reads on the keyboard over the first alias', () => {
    expect(describeShortcut('return')).toBe('Enter')
    expect(describeShortcut('esc')).toBe('Esc')
    expect(describeShortcut('pageup')).toBe('Page Up')
    expect(describeShortcut('pagedown')).toBe('Page Down')
    expect(describeShortcut('delete')).toBe('Delete')
    expect(describeShortcut('left')).toBe('←')
  })

  it('uppercases printable keys and keeps function keys', () => {
    expect(describeShortcut('a')).toBe('A')
    expect(describeShortcut('1')).toBe('1')
    expect(describeShortcut('cmd+f5')).toBe('⌘F5')
  })

  it('returns the input verbatim when it cannot be pressed', () => {
    expect(describeShortcut('cmd+foo')).toBe('cmd+foo')
    expect(describeShortcut('a+b')).toBe('a+b')
    expect(describeShortcut('-')).toBe('-')
  })

  it('describes the same shortcut the same way however it was written', () => {
    for (const input of ['⌘S', 'cmd+s', 'Cmd + S', 'super+s']) {
      expect(describeShortcut(input), input).toBe('⌘S')
    }
  })
})
