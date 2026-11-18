/**
 * Sending a copy or paste keystroke into the frontmost application.
 *
 * This needs the Accessibility grant; the helper answers with
 * `accessibility-denied` otherwise and the caller turns that into a message the
 * user can act on.
 */

import { runHelper, runOsascript } from './process'

/** Synthesizes Cmd+C / Cmd+V into whatever app currently has focus. */
export async function helperSendKey(command: 'copy' | 'paste'): Promise<boolean> {
  const payload = await runHelper([command])
  if (payload?.ok) return true
  const key = command === 'copy' ? 'c' : 'v'
  const result = await runOsascript([
    `tell application "System Events" to keystroke "${key}" using command down`
  ])
  return result !== null
}
