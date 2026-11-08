/**
 * Hotkey recorder: captures the next key combination and converts it to an
 * Electron accelerator string. Modifiers alone are ignored, so the user cannot
 * accidentally bind a bare letter to a global shortcut.
 */

import { useEffect, useRef, useState } from 'react'

const MODIFIER_KEYS = new Set(['Meta', 'Control', 'Alt', 'Shift', 'CapsLock', 'Fn'])

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

function keyFromEvent(event: KeyboardEvent): string | null {
  if (event.code.startsWith('Key')) return event.code.slice(3)
  if (event.code.startsWith('Digit')) return event.code.slice(5)
  if (/^F\d{1,2}$/.test(event.code)) return event.code
  return CODE_MAP[event.code] ?? null
}

function toAccelerator(event: KeyboardEvent): string | null {
  const key = keyFromEvent(event)
  if (!key) return null

  const parts: string[] = []
  if (event.metaKey) parts.push('Command')
  if (event.ctrlKey) parts.push('Control')
  if (event.altKey) parts.push('Alt')
  if (event.shiftKey) parts.push('Shift')

  // A global shortcut without any modifier would swallow ordinary typing.
  if (parts.length === 0) return null
  parts.push(key)
  return parts.join('+')
}

export function prettyHotkey(accelerator: string): string {
  return accelerator
    .split('+')
    .map((part) => {
      if (part === 'Command' || part === 'Cmd') return '⌘'
      if (part === 'Control' || part === 'Ctrl') return '⌃'
      if (part === 'Alt' || part === 'Option') return '⌥'
      if (part === 'Shift') return '⇧'
      return part
    })
    .join(' ')
}

interface HotkeyFieldProps {
  value: string
  onChange(accelerator: string): void
}

export function HotkeyField({ value, onChange }: HotkeyFieldProps) {
  const [recording, setRecording] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const buttonRef = useRef<HTMLButtonElement | null>(null)

  useEffect(() => {
    if (!recording) return

    const handler = (event: KeyboardEvent): void => {
      event.preventDefault()
      event.stopPropagation()
      if (event.key === 'Escape') {
        setRecording(false)
        setError(null)
        return
      }
      if (MODIFIER_KEYS.has(event.key)) return

      const accelerator = toAccelerator(event)
      if (!accelerator) {
        setError('Нужна комбинация с ⌘, ⌥, ⌃ или ⇧')
        return
      }
      setRecording(false)
      setError(null)
      onChange(accelerator)
    }

    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [recording, onChange])

  return (
    <div className="hotkey-field">
      <button
        ref={buttonRef}
        className={recording ? 'recording' : ''}
        aria-pressed={recording}
        onClick={() => {
          setError(null)
          setRecording((prev) => !prev)
        }}
        /**
         * Two recorders can be on screen at once — the card key and the voice key
         * share the sidebar footer — and both listen on `window`. Without this,
         * starting the second one left the first still armed, and one keystroke
         * was written into both shortcuts. Moving focus away is the same gesture
         * that ends the recording, so it is also the one that disarms it.
         */
        onBlur={() => {
          setRecording(false)
          setError(null)
        }}
      >
        {recording ? 'Нажмите комбинацию…' : prettyHotkey(value)}
      </button>
      {recording && <span className="hint">Esc — отмена</span>}
      {error && <span className="hint err">{error}</span>}
    </div>
  )
}