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
  helperWindow
} from './apps'
export type { RawFrontApp, RunningApp } from './apps'
export { helperProbe } from './ax'
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
 */
export interface AbortWatcher {
  stop(): void
}

export function watchForAbort(
  mode: AbortWatchMode,
  onAbort: (reason: 'escape' | 'mousemove') => void
): AbortWatcher | null {
  const binary = helperBinary()
  if (!binary) return null
  const child = spawn(binary, ['watch', mode], {
    stdio: ['ignore', 'pipe', 'ignore']
  })
  const lines = createInterface({ input: child.stdout })
  lines.on('line', (line) => {
    let payload: { event?: string } | null = null
    try {
      payload = JSON.parse(line) as { event?: string }
    } catch {
      return
    }
    if (payload?.event === 'interaction' || payload?.event === 'escape') onAbort('escape')
    else if (payload?.event === 'mousemove') onAbort('mousemove')
  })
  child.on('error', () => undefined)
  return {
    stop(): void {
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

