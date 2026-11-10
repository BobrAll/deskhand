/**
 * Bridge to the small ObjC helper that ships with the app.
 *
 * Electron cannot (a) reliably synthesize Cmd+C/Cmd+V into a *foreign*
 * application, (b) enumerate the focused window of another process, or
 * (c) query the TCC permission state. The helper covers exactly those gaps.
 * Context and clipboard helpers can fall back to osascript. Agent input
 * requires the native binary.
 *
 * This module is the public surface. The helper's work is split by concern:
 * `process.ts` spawns it, `ax.ts` maps Accessibility, `input.ts` posts input and
 * `apps.ts` enumerates applications. Everything is re-exported here so callers
 * keep importing from one place.
 */

import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import type { PermissionState } from '@shared/types'
import { helperBinary, numberOf, runHelper } from './process'

export { helperBinary } from './process'
export {
  helperActivate,
  helperFront,
  helperFrontApp,
  helperLaunch,
  helperRunningApps,
  helperWindow
} from './apps'
export type { HelperLaunched, RawFrontApp, RunningApp } from './apps'
export { helperFocused, helperProbe } from './ax'
export {
  helperClick,
  helperDrag,
  helperMoveMouse,
  helperPressKey,
  helperScroll,
  helperSendKey,
  helperTypeText
} from './input'
export type { HelperClickButton, NativeInputTarget } from './input'

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
  options: { watchMouse: boolean; interaction?: boolean },
  onAbort: (reason: 'escape' | 'mousemove') => void
): AbortWatcher | null {
  const binary = helperBinary()
  if (!binary) return null
  const child = spawn(binary, ['watch', options.interaction ? 'interaction' : options.watchMouse ? 'mouse' : 'key'], {
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

/** Mouse position in top-left screen coordinates (used when Electron's own API is unavailable). */
export async function helperCursor(): Promise<{ x: number; y: number } | null> {
  const payload = await runHelper(['cursor'])
  if (!payload?.ok) return null
  const x = numberOf(payload.x)
  const y = numberOf(payload.y)
  if (x === null || y === null) return null
  return { x, y }
}
