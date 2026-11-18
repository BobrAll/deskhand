/**
 * Key codes for the push-to-talk accelerator.
 *
 * One parser reads these tables: `main/voice/listen.ts` turns the user's
 * accelerator ("Alt+Shift+Space") into the key code and modifier mask the native
 * keyboard tap needs. A bare key is never valid there — the parser returns null
 * unless it finds at least one modifier — so only combinations live in the
 * grammar. A hold of two or more modifiers (Control+Alt) is valid as well and
 * needs no entry here. The parser stays in its own file; only the numbers live
 * here, so a wrong keycode is fixed in one place.
 *
 * `KEY_CODES` is the full table and the source of truth; `VOICE_KEY_CODES` is the
 * subset that parser accepts. The subset has always been the full table minus
 * two aliases: `esc` (the voice table only knows `escape`) and `forwarddelete`
 * (only `delete`). That is not cosmetic — whether "Alt+esc" is a valid
 * accelerator is decided by this table alone, and letting `esc` in would turn it
 * from a validation error into a registerable global hotkey. The subset is
 * therefore kept explicit, and `keycodes.test.ts` pins both sizes so that adding
 * a key to `KEY_CODES` fails loudly instead of silently widening the hotkey
 * grammar.
 *
 * Pure data, no imports: usable from either process and testable alone.
 */

/** `kVK_*` codes. Values are the hardware codes, not the characters. */
export const KEY_CODES: Record<string, number> = {
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

/** F1–F20 have a non-contiguous table of their own. Identical in both parsers. */
export const FUNCTION_CODES: Record<number, number> = {
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

/**
 * The aliases the voice parser has never accepted.
 *
 * Kept as a named list rather than a second literal table: the values are the
 * same hardware codes, and a copy would drift. See the file header for why
 * removing this list would change behaviour.
 */
const NOT_IN_VOICE = ['esc', 'forwarddelete'] as const

/** The subset of `KEY_CODES` a push-to-talk accelerator may use. */
export const VOICE_KEY_CODES: Record<string, number> = Object.fromEntries(
  Object.entries(KEY_CODES).filter(([name]) => !(NOT_IN_VOICE as readonly string[]).includes(name))
)
