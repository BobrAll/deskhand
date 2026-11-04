/** Small shared helpers for the main process. */

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
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

