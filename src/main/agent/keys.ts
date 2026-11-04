/**
 * Shortcuts as the model writes them ("cmd+s", "enter", "ctrl+shift+tab") turned
 * into the two numbers the helper posts: a virtual key code and a modifier mask.
 *
 * This is a second table on purpose. `voice/listen.ts` parses the *user's*
 * push-to-talk accelerator, where a bare key is never valid and only a handful
 * of combinations make sense; here a bare `enter` is the most common thing in
 * the world, and the set of keys a plan may press is the whole keyboard. Sharing
 * one table would mean one of the two callers bending its rules for the other.
 *
 * No Electron or Node imports: the table is pure data and can be tested alone.
 */

/** `kVK_*` codes. Values are the hardware codes, not the characters. */
const KEY_CODES: Record<string, number> = {
  return: 36,
  enter: 36,
  tab: 48,
  space: 49,
  escape: 53,
  esc: 53,
  backspace: 51,
  delete: 117,
  forwarddelete: 117,
  up: 126,
  down: 125,
  left: 123,
  right: 124,
  home: 115,
  end: 119,
  pageup: 116,
  pagedown: 121,
  ',': 43,
  '.': 47,
  '/': 44,
  ';': 41,
  "'": 39,
  '[': 33,
  ']': 30,
  '\\': 42,
  '-': 27,
  '=': 24,
  '`': 50,
  a: 0,
  s: 1,
  d: 2,
  f: 3,
  h: 4,
  g: 5,
  z: 6,
  x: 7,
  c: 8,
  v: 9,
  b: 11,
  q: 12,
  w: 13,
  e: 14,
  r: 15,
  y: 16,
  t: 17,
  '1': 18,
  '2': 19,
  '3': 20,
  '4': 21,
  '5': 23,
  '6': 22,
  '7': 26,
  '8': 28,
  '9': 25,
  '0': 29,
  o: 31,
  u: 32,
  i: 34,
  p: 35,
  l: 37,
  j: 38,
  k: 40,
  n: 45,
  m: 46
}

/** F1–F20 have a non-contiguous table of their own. */
const FUNCTION_CODES: Record<number, number> = {
  1: 122,
  2: 120,
  3: 99,
  4: 118,
  5: 96,
  6: 97,
  7: 98,
  8: 100,
  9: 101,
  10: 109,
  11: 103,
  12: 111,
  13: 105,
  14: 107,
  15: 113,
  16: 106,
  17: 64,
  18: 79,
  19: 80,
  20: 90
}

const MODIFIER_FLAGS: Record<string, number> = {
  // kCGEventFlagMaskCommand / Shift / Control / Alternate
  cmd: 0x00100000,
  command: 0x00100000,
  meta: 0x00100000,
  super: 0x00100000,
  shift: 0x00020000,
  ctrl: 0x00040000,
  control: 0x00040000,
  alt: 0x00080000,
  opt: 0x00080000,
  option: 0x00080000
}

export interface ParsedKey {
  keyCode: number
  flags: number
}

/**
 * Parses a shortcut. Returns `null` for anything that cannot be pressed, so the
 * runner can skip the step and say so instead of posting a random key code.
 *
 * Tolerant where models drift: `⌘S`, `cmd+s`, `Cmd + S`, `cmd-shift-s` and
 * `super+s` all mean the same thing.
 */
export function parseShortcut(input: string): ParsedKey | null {
  const normalized = input
    .replace(/⌘/g, 'cmd+')
    .replace(/⇧/g, 'shift+')
    .replace(/⌥/g, 'alt+')
    .replace(/⌃/g, 'ctrl+')
    .replace(/[\s\-_]+/g, '+')
    .trim()
    .toLowerCase()
  if (!normalized) return null

  const parts = normalized.split('+').filter(Boolean)
  if (parts.length === 0) return null

  let flags = 0
  let keyCode: number | null = null

  for (const part of parts) {
    const modifier = MODIFIER_FLAGS[part]
    if (modifier !== undefined) {
      flags |= modifier
      continue
    }
    // A second non-modifier means the string is not a shortcut at all.
    if (keyCode !== null) return null

    if (KEY_CODES[part] !== undefined) {
      keyCode = KEY_CODES[part]
      continue
    }
    const fn = /^f(\d{1,2})$/.exec(part)
    if (fn && FUNCTION_CODES[Number(fn[1])] !== undefined) {
      keyCode = FUNCTION_CODES[Number(fn[1])]
      continue
    }
    return null
  }

  if (keyCode === null) return null
  return { keyCode, flags }
}

/**
 * Canonical display names, keyed by code.
 *
 * A reverse lookup into `KEY_CODES` would find the *first* alias ('return' before
 * 'enter') and print `Return` — technically the same key, but the card is read by
 * a person who pressed "Enter" on their keyboard, not "Return".
 */
const KEY_NAMES: Record<number, string> = {
  36: 'Enter',
  48: 'Tab',
  49: 'Space',
  53: 'Esc',
  51: 'Backspace',
  117: 'Delete',
  126: '↑',
  125: '↓',
  123: '←',
  124: '→',
  115: 'Home',
  119: 'End',
  116: 'Page Up',
  121: 'Page Down'
}

/** How a shortcut is shown in the card ("⌘S", "Enter"). */
export function describeShortcut(input: string): string {
  const parsed = parseShortcut(input)
  if (!parsed) return input
  const symbols: string[] = []
  if (parsed.flags & MODIFIER_FLAGS.ctrl) symbols.push('⌃')
  if (parsed.flags & MODIFIER_FLAGS.alt) symbols.push('⌥')
  if (parsed.flags & MODIFIER_FLAGS.shift) symbols.push('⇧')
  if (parsed.flags & MODIFIER_FLAGS.cmd) symbols.push('⌘')
  const named = KEY_NAMES[parsed.keyCode]
  if (named) return `${symbols.join('')}${named}`

  // Everything left is a printable key: print the label a Mac keyboard carries.
  const printable = PRINTABLE[parsed.keyCode] ?? ''
  return `${symbols.join('')}${printable.toUpperCase()}`
}

const PRINTABLE: Record<number, string> = {
  0: 'a', 1: 's', 2: 'd', 3: 'f', 4: 'h', 5: 'g', 6: 'z', 7: 'x', 8: 'c', 9: 'v',
  11: 'b', 12: 'q', 13: 'w', 14: 'e', 15: 'r', 16: 'y', 17: 't',
  18: '1', 19: '2', 20: '3', 21: '4', 22: '6', 23: '5', 25: '9', 26: '7', 28: '8', 29: '0',
  24: '=', 27: '-', 30: ']', 31: 'o', 32: 'u', 33: '[', 34: 'i', 35: 'p', 37: 'l',
  38: 'j', 39: "'", 40: 'k', 41: ';', 42: '\\', 43: ',', 44: '/', 45: 'n', 46: 'm',
  47: '.', 50: '`',
  64: 'F17', 79: 'F18', 80: 'F19', 90: 'F20', 96: 'F5', 97: 'F6', 98: 'F7', 99: 'F3',
  100: 'F8', 101: 'F9', 103: 'F11', 105: 'F13', 106: 'F16', 107: 'F14', 109: 'F10',
  111: 'F12', 113: 'F15', 118: 'F4', 120: 'F2', 122: 'F1'
}
