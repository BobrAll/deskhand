/** Small shared helpers for the main process. */

import { traceEnd } from './agent/trace'

export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  const end = traceEnd('timer', { requestedMs: ms })
  return new Promise((resolve) => {
    const finish = (): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', finish)
      end()
      resolve()
    }
    const timer = setTimeout(finish, ms)
    if (signal?.aborted) finish()
    else signal?.addEventListener('abort', finish, { once: true })
  })
}

/** Polls `check` until it returns true or the timeout elapses. */
export async function waitFor(
  check: () => Promise<boolean> | boolean,
  timeoutMs: number,
  intervalMs = 40
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return true
    await delay(intervalMs)
  }
  return false
}

export function truncate(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false }
  return { text: text.slice(0, max), truncated: true }
}

/**
 * Clamps a number into a range, treating "not a number" as the floor.
 *
 * `overlay:resize` is not type-checked at the IPC boundary, and `setBounds`
 * throws in the native layer on NaN. The floor is the honest answer for
 * "there is no number at all".
 */
export function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(Math.max(value, min), max)
}

