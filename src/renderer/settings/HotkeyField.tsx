/**
 * Hotkey recorder: arms a field, silences the app's own listeners, and asks
 * `hotkeyCapture.ts` what the press means.
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
import { isModifierKey, modifierParts, toAccelerator } from './hotkeyCapture'
import { modifierHold } from './modifierHold'

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
      if (isModifierKey(event.key)) {
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
      if (!allowModifiersOnly || !isModifierKey(event.key)) return
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
