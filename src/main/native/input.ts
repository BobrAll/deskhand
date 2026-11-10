/**
 * Posting input into the frontmost application.
 *
 * Every function here needs the Accessibility grant; the helper answers with
 * `accessibility-denied` otherwise and the caller turns that into a message the
 * user can act on. `false` may mean partial input or an unknown effect.
 */

import type { RawFrontApp } from './apps'
import { HELPER_TIMEOUT_MS, runHelper, runOsascript } from './process'

/** A long paragraph is one helper call, and the per-character pacing is what sets the ceiling. */
const MAX_TYPE_TIMEOUT_MS = 30_000
/** Fixed part of the typing budget: process start plus the first key. */
const TYPE_TIMEOUT_BASE_MS = 4_000
/** Budget per character the helper types. */
const TYPE_TIMEOUT_PER_CHAR_MS = 40

export interface NativeInputTarget {
  pid: number
  windowId: number | null
  bounds: RawFrontApp['bounds']
  signal: AbortSignal
}

function runInput(args: string[], target?: NativeInputTarget, timeout = HELPER_TIMEOUT_MS) {
  const bounds = target?.bounds
  const geometry = bounds ? [bounds.x, bounds.y, bounds.width, bounds.height].join(',') : '-'
  return runHelper(target ? ['input', String(target.pid), String(target.windowId ?? 0), geometry, ...args] : args,
    timeout, target?.signal)
}

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

/** Moves the pointer to a point in global screen coordinates (points). */
export async function helperMoveMouse(x: number, y: number, target?: NativeInputTarget): Promise<boolean> {
  const payload = await runInput(['move', String(Math.round(x)), String(Math.round(y))], target)
  return payload?.ok === true
}

export type HelperClickButton = 'left' | 'right' | 'double'

/** Moves the pointer, then clicks (once, or twice for `double`). */
export async function helperClick(
  x: number,
  y: number,
  button: HelperClickButton = 'left',
  target?: NativeInputTarget
): Promise<boolean> {
  const payload = await runInput([
    'click',
    String(Math.round(x)),
    String(Math.round(y)),
    button
  ], target)
  return payload?.ok === true
}

/** Presses and holds the left button while travelling to a second point. */
export async function helperDrag(
  from: { x: number; y: number },
  to: { x: number; y: number },
  target?: NativeInputTarget
): Promise<boolean> {
  const payload = await runInput([
    'drag',
    String(Math.round(from.x)),
    String(Math.round(from.y)),
    String(Math.round(to.x)),
    String(Math.round(to.y))
  ], target)
  return payload?.ok === true
}

/** Posts a wheel event; positive `dy` scrolls content up (natural direction). */
export async function helperScroll(dx: number, dy: number, target?: NativeInputTarget): Promise<boolean> {
  const payload = await runInput(['scroll', String(Math.round(dx)), String(Math.round(dy))], target)
  return payload?.ok === true
}

/** Types text into the focused field. Unicode-safe: the payload travels as base64. */
export async function helperTypeText(text: string, target?: NativeInputTarget): Promise<boolean> {
  if (!text) return true
  const encoded = Buffer.from(text, 'utf8').toString('base64')
  // A long paragraph is one helper call; the argument list is fine for it, but
  // the timeout has to cover the per-character pacing the helper does.
  const timeout = Math.min(MAX_TYPE_TIMEOUT_MS, TYPE_TIMEOUT_BASE_MS + text.length * TYPE_TIMEOUT_PER_CHAR_MS)
  const payload = await runInput(['type', encoded], target, timeout)
  return payload?.ok === true
}

/** Presses one key with a modifier mask (shortcuts, Return, Tab, arrows). */
export async function helperPressKey(keyCode: number, flags: number, target?: NativeInputTarget): Promise<boolean> {
  const payload = await runInput(['key', String(keyCode), String(flags)], target)
  return payload?.ok === true
}
