/**
 * Hotkey recorder: captures the next key combination and converts it to an
 * Electron accelerator string. A bare letter is always ignored, so ordinary
 * typing cannot become a shortcut. A hold of two modifiers is accepted only for
 * the voice fields, where the native tap can watch a modifier pair directly.
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
import { modifierHold } from './modifierHold'

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

/** The modifiers currently down, in the order the accelerator spells them. */
function modifierParts(event: KeyboardEvent, includeFn: boolean): string[] {
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

function toAccelerator(event: KeyboardEvent, includeFn: boolean): string | null {
  const key = keyFromEvent(event)
  if (!key) return null

  const parts = modifierParts(event, includeFn)
  // A global shortcut without any modifier would swallow ordinary typing.
  if (parts.length === 0) return null
  parts.push(key)
  return parts.join('+')
}

interface HotkeyFieldProps {
  value: string
  onChange(accelerator: string): void
  /** Accept a hold of two or more modifiers, e.g. Control+Alt. */
  allowModifiersOnly?: boolean
}

export function HotkeyField({ value, onChange, allowModifiersOnly = false }: HotkeyFieldProps) {
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

    // The full set of modifiers seen while they were down. A modifier-only
    // combination is committed on release, when the event no longer carries the
    // key that was just let go.
    let held: string[] = []

    const handler = (event: KeyboardEvent): void => {
      event.preventDefault()
      event.stopPropagation()
      if (event.key === 'Escape') {
        setArmed(false)
        setError(null)
        return
      }
      if (MODIFIER_KEYS.has(event.key)) {
        if (allowModifiersOnly) held = modifierParts(event, true)
        return
      }

      const accelerator = toAccelerator(event, allowModifiersOnly)
      if (!accelerator) {
        setError('Нужна комбинация с ⌘, ⌥, ⌃, ⇧ или fn')
        return
      }
      setArmed(false)
      setError(null)
      onChange(accelerator)
    }

    const release = (event: KeyboardEvent): void => {
      if (!allowModifiersOnly || !MODIFIER_KEYS.has(event.key)) return
      event.preventDefault()
      event.stopPropagation()
      // Fn may never report its own key-up on macOS; let Ctrl/Alt/⌘/⇧ ending the
      // hold commit the pair that was down a moment ago.
      const current = modifierParts(event, true)
      const remaining = current.filter((part) => part !== 'Fn')
      if (remaining.length > 0) return
      // Ctrl may have gone down before Fn, and Fn may never have produced a
      // keydown of its own. The keyup still carries its modifier state, so the
      // union is what the user was actually holding.
      const accelerator = modifierHold(held, current)
      held = []
      if (!accelerator) return
      setArmed(false)
      setError(null)
      onChange(accelerator)
    }

    window.addEventListener('keydown', handler, true)
    window.addEventListener('keyup', release, true)
    return () => {
      window.removeEventListener('keydown', handler, true)
      window.removeEventListener('keyup', release, true)
    }
  }, [recording, onChange, setArmed, allowModifiersOnly])

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
         * The card and voice recorders can be on screen at once, and both
         * listen on `window`. Without this,
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
        {recording ? 'Нажми комбинацию…' : prettyAccelerator(value)}
      </button>
      {recording && <span className="hint">Esc — отмена</span>}
      {error && <span className="hint err">{error}</span>}
    </div>
  )
}
