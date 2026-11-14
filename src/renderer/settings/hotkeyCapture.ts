/**
 * Turning a keystroke into an Electron accelerator.
 *
 * The recorder in `HotkeyField` owns the UI and the arm/disarm dance; what a
 * press *means* is pure and lives here, so the edges that used to be reachable
 * only by pressing keys by hand — a bare letter, a digit, a pair of modifiers
 * held on their own — are checked by a test.
 *
 * A bare letter is always ignored: a global shortcut without a modifier would
 * swallow ordinary typing. A hold of two modifiers is accepted only for the voice
 * fields, where the native tap can watch a modifier pair directly.
 */

const MODIFIER_KEYS = new Set(['Meta', 'Control', 'Alt', 'Shift', 'CapsLock', 'Fn'])

/** Keys whose `KeyboardEvent.code` is a name rather than a letter or a digit. */
const CODE_MAP: Record<string, string> = {
  Space: 'Space',
  Enter: 'Enter',
  Tab: 'Tab',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Escape: 'Escape',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
  Backquote: '`'
}

/** Whether the press is the modifier itself, rather than a key it modifies. */
export function isModifierKey(key: string): boolean {
  return MODIFIER_KEYS.has(key)
}

/**
 * The accelerator's name for the physical key.
 *
 * `code` rather than `key`, so the shortcut is the key the hand found and not the
 * character the current layout puts on it: ⌘Z stays ⌘Z on a Cyrillic layout.
 */
export function keyFromEvent(event: KeyboardEvent): string | null {
  if (event.code.startsWith('Key')) return event.code.slice(3)
  if (event.code.startsWith('Digit')) return event.code.slice(5)
  if (/^F\d{1,2}$/.test(event.code)) return event.code
  return CODE_MAP[event.code] ?? null
}

/** The modifiers currently down, in the order the accelerator spells them. */
export function modifierParts(event: KeyboardEvent, includeFn: boolean): string[] {
  const parts: string[] = []
  if (event.metaKey) parts.push('Command')
  if (event.ctrlKey) parts.push('Control')
  if (event.altKey) parts.push('Alt')
  if (event.shiftKey) parts.push('Shift')
  // Chromium does not always deliver Fn as a key edge, but its modifier state
  // is still readable on the events it does deliver.
  if (includeFn && event.getModifierState('Fn')) parts.push('Fn')
  return parts
}

/** The accelerator a key press records, or `null` when it is not a shortcut. */
export function toAccelerator(event: KeyboardEvent, includeFn: boolean): string | null {
  const key = keyFromEvent(event)
  if (!key) return null

  const parts = modifierParts(event, includeFn)
  // A global shortcut without any modifier would swallow ordinary typing.
  if (parts.length === 0) return null
  parts.push(key)
  return parts.join('+')
}
