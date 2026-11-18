/**
 * How a combination is spelled back to the person who chose it.
 *
 * The tray menu and the settings field both print accelerators, and they must
 * agree: "⌥ Space" in one place and "Alt+Space" in the other reads like two
 * different settings.
 */

import { describe, expect, it } from 'vitest'
import { prettyAccelerator } from './accelerator'

describe('prettyAccelerator', () => {
  it('draws the modifiers as the symbols on the key caps', () => {
    expect(prettyAccelerator('Alt+Space')).toBe('⌥ Space')
    expect(prettyAccelerator('Alt+Shift+Space')).toBe('⌥ ⇧ Space')
    expect(prettyAccelerator('Command+Control+Alt+Shift+K')).toBe('⌘ ⌃ ⌥ ⇧ K')
  })

  it('accepts the aliases Electron writes', () => {
    expect(prettyAccelerator('Cmd+Opt+V')).toBe('⌘ ⌥ V')
    expect(prettyAccelerator('Control+Alt')).toBe('⌃ ⌥')
    expect(prettyAccelerator('Fn+Control')).toBe('fn ⌃')
  })

  it('keeps an unknown key as it was written', () => {
    expect(prettyAccelerator('Alt+F5')).toBe('⌥ F5')
    expect(prettyAccelerator('Alt+Space')).not.toContain('Alt')
  })
})
