/**
 * Hotkey recorder: captures the next key combination and converts it to an
 * Electron accelerator string. Modifiers alone are ignored, so the user cannot
 * accidentally bind a bare letter — or a bare modifier — to a global shortcut.
 *
 * One thing here is not obvious: the app's own listeners are silenced while the
 * field is armed. Both the card hotkey and the voice tap are global, so the
 * combination being typed would be swallowed by the old binding before this
 * field ever saw it — re-assigning a shortcut to itself was impossible, and
 * re-assigning it to another one fired the old action mid-recording.
 * `settings.recording` tells the main process to stand down, and to come back
 * with whatever is stored once the field is done.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { prettyAccelerator } from '@shared/accelerator'

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

interface HotkeyFieldProps {
  value: string
  onChange(accelerator: string): void
}

export function HotkeyField({ value, onChange }: HotkeyFieldProps) {
  const [recording, setRecording] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const setArmed = useCallback((active: boolean) => {
    setRecording(active)
    // The main process re-reads the stored accelerator when this goes false, so
    // a combination the system refused is not re-armed by accident.
    window.deskhand.settings.recording(active)
  }, [])

  useEffect(() => {
    if (!recording) return

    const handler = (event: KeyboardEvent): void => {
      event.preventDefault()
      event.stopPropagation()
      if (event.key === 'Escape') {
        setArmed(false)
        setError(null)
        return
      }
      if (MODIFIER_KEYS.has(event.key)) return

      const accelerator = toAccelerator(event)
      if (!accelerator) {
        setError('Нужна комбинация с ⌘, ⌥, ⌃ или ⇧')
        return
      }
      setArmed(false)
      setError(null)
      onChange(accelerator)
    }

    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [recording, onChange, setArmed])

  // Closing the tab or the window while armed must not leave the app deaf.
  const armedRef = useRef(false)
  useEffect(() => {
    armedRef.current = recording
  }, [recording])
  useEffect(
    () => () => {
      if (armedRef.current) window.deskhand.settings.recording(false)
    },
    []
  )

  return (
    <div className="hotkey-field">
      <button
        className={recording ? 'recording' : ''}
        aria-pressed={recording}
        onClick={() => {
          setError(null)
          setArmed(!recording)
        }}
        /**
         * Two recorders can be on screen at once — the card key and the voice key
         * share the sidebar footer — and both listen on `window`. Without this,
         * starting the second one left the first still armed, and one keystroke
         * was written into both shortcuts. Moving focus away is the same gesture
         * that ends the recording, so it is also the one that disarms it.
         */
        onBlur={() => {
          if (!recording) return
          setArmed(false)
          setError(null)
        }}
      >
        {recording ? 'Нажмите комбинацию…' : prettyAccelerator(value)}
      </button>
      {recording && <span className="hint">Esc — отмена</span>}
      {error && <span className="hint err">{error}</span>}
    </div>
  )
}
