/**
 * Accelerator helpers shared by the two parsers and the UI.
 *
 * Two things live here because both sides of the app must spell a combination
 * the same way: the `CGEventFlags` values a modifier name stands for (the voice
 * tap parses accelerators into those), and how a person reads one back.
 */

/** `kVK_*` modifier masks, as `CGEventFlags` values. */
export const MODIFIER_FLAGS: Record<string, number> = {
  // kCGEventFlagMaskCommand / Shift / Control / Alternate
  command: 0x00100000,
  cmd: 0x00100000,
  meta: 0x00100000,
  control: 0x00040000,
  ctrl: 0x00040000,
  alt: 0x00080000,
  option: 0x00080000,
  opt: 0x00080000,
  shift: 0x00020000
}

/** `Control+Alt` as a person reads it: `⌃ ⌥`. */
export function prettyAccelerator(accelerator: string): string {
  return accelerator
    .split('+')
    .map((part) => {
      const name = part.trim().toLowerCase()
      if (name === 'command' || name === 'cmd' || name === 'meta') return '⌘'
      if (name === 'control' || name === 'ctrl') return '⌃'
      if (name === 'alt' || name === 'option' || name === 'opt') return '⌥'
      if (name === 'shift') return '⇧'
      return part.trim()
    })
    .join(' ')
}
