/**
 * Bridge to the small ObjC helper that ships with the app.
 *
 * Electron cannot (a) reliably synthesize Cmd+C/Cmd+V into a *foreign*
 * application, (b) enumerate the focused window of another process, or
 * (c) query the TCC permission state. The helper covers exactly those gaps.
 * Context and clipboard helpers can fall back to osascript.
 *
 * This module is the public surface. The helper's work is split by concern:
 * `process.ts` spawns it, `ax.ts` maps Accessibility, `input.ts` sends the
 * copy/paste keystroke and `apps.ts` enumerates applications. Everything is
 * re-exported here so callers keep importing from one place.
 */

import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import type { PermissionState } from '@shared/types'
import { helperBinary, runHelper } from './process'

export { helperBinary } from './process'
export {
  helperActivate,
  helperFrontApplication,
  helperFrontWindow,
  helperRunningApps,
  helperVisibleBundleIds,
  helperWindow
} from './apps'
export type { RawFrontApp, RunningApp } from './apps'
export { helperFocused, helperProbe } from './ax'
export { helperSendKey } from './input'

/**
 * What the watcher listens to.
 *
 * `key` is Escape only, `mouse` adds pointer movement, and `interaction` is the
 * helper's own gesture detector — used where the drawing layer must disappear on
 * the first thing the user does with either device.
 */
export type AbortWatchMode = 'key' | 'mouse' | 'interaction'

/**
 * Starts the long-lived Escape / mouse-movement watcher.
 *
 * Returns a handle rather than a promise: the process prints `ready` and then
 * one line per event until it is killed, exactly like the voice tap. The caller
 * stops it with `stop()`, which is what makes a plan interruptible.
 *
 * The helper can also refuse and exit at once — without Accessibility it prints
 * `{"ok":false,"error":"accessibility-denied"}` and returns. That death used to
 * be invisible: the handle kept looking alive while the drawing layer silently
 * stopped dismissing on the next click. It is logged here; `onFailure` is an
 * optional hook for a caller that can react (the current drawing and agent
 * watchers do not pass one).
 */
export interface AbortWatcher {
  stop(): void
}

/** One line of helper output: an event, or a refusal. */
interface WatchLine {
  ok?: boolean
  event?: string
  error?: string
}

/** What to tell the caller when the helper exits by itself. */
function exitReason(code: number | null, signal: NodeJS.Signals | null): string {
  return signal ? `helper exited after ${signal}` : `helper exited with code ${String(code)}`
}

export function watchForAbort(
  mode: AbortWatchMode,
  onAbort: (reason: 'escape' | 'mousemove') => void,
  onFailure?: (message: string) => void
): AbortWatcher | null {
  const binary = helperBinary()
  if (!binary) return null
  const child = spawn(binary, ['watch', mode], {
    stdio: ['ignore', 'pipe', 'ignore']
  })
  const lines = createInterface({ input: child.stdout })
  /** Set by the first failure or by `stop()`, so one death is reported once. */
  let finished = false

  const fail = (reason: string): void => {
    if (finished) return
    finished = true
    console.warn(`[native] abort watcher (${mode}) stopped: ${reason}`)
    onFailure?.(reason)
    try {
      lines.close()
    } catch {
      // The pipe may already be gone with the process.
    }
  }

  lines.on('line', (line) => {
    let payload: WatchLine | null = null
    try {
      payload = JSON.parse(line) as WatchLine
    } catch {
      return
    }
    if (!payload) return
    if (payload.error) {
      fail(payload.error)
      return
    }
    if (payload.ok === false) {
      fail('the helper refused to watch')
      return
    }
    if (payload.event === 'interaction' || payload.event === 'escape') onAbort('escape')
    else if (payload.event === 'mousemove') onAbort('mousemove')
  })
  child.on('error', (error) => fail(error.message))
  child.on('exit', (code, signal) => fail(exitReason(code, signal)))
  return {
    stop(): void {
      finished = true
      lines.close()
      child.kill('SIGTERM')
    }
  }
}

/**
 * Current permission state; `shouldRequest` triggers the macOS prompts.
 *
 * The microphone is not in the result: it is a per-process TCC grant that only
 * Electron's own `systemPreferences` can ask for, so `permissions.ts` fills it in.
 */
export async function helperPermissions(
  shouldRequest: boolean
): Promise<Pick<PermissionState, 'accessibility' | 'screenRecording'> | null> {
  const payload = await runHelper([shouldRequest ? 'request-permissions' : 'permissions'])
  if (!payload?.ok) return null
  return {
    accessibility: payload.accessibility === true,
    screenRecording: payload.screenRecording === true
  }
}

