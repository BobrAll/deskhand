/**
 * Which application is in front, and how to bring another one there.
 *
 * The helper answers with a JSON object per call; this module maps that into
 * the `RawFrontApp` shape the context collector and the overlay understand, and
 * falls back to AppleScript for the identity-only questions osascript can answer.
 */

import {
  flag,
  mapBounds,
  numberOf,
  runHelper,
  runOsascript,
  HELPER_TIMEOUT_MS,
  type HelperPayload
} from './process'

/** Starting an app can wait for a cold launch; every other app call uses the default. */
const LAUNCH_TIMEOUT_MS = 15_000

export interface RawFrontApp {
  bundleId: string
  name: string
  pid: number
  windowId: number | null
  windowTitle: string | null
  bounds: { x: number; y: number; width: number; height: number } | null
  accessibility: boolean
}

function mapFront(payload: HelperPayload | null): RawFrontApp | null {
  if (!payload?.ok) return null
  const bundleId = typeof payload.bundleId === 'string' ? payload.bundleId : ''
  const pid = numberOf(payload.pid)
  if (pid === null) return null
  return {
    bundleId,
    name: typeof payload.name === 'string' ? payload.name : bundleId,
    pid,
    windowId: numberOf(payload.windowId),
    windowTitle: typeof payload.title === 'string' && payload.title ? payload.title : null,
    bounds: mapBounds(payload.bounds),
    accessibility: flag(payload.accessibility)
  }
}

/** Re-read the focused window of the app under the overlay, without activating it. */
export async function helperWindow(pid: number): Promise<RawFrontApp | null> {
  if (!Number.isInteger(pid) || pid <= 0) return null
  return mapFront(await runHelper(['window', String(pid)]))
}

/** Frontmost application plus its focused window, as seen by macOS. */
export async function helperFrontWindow(): Promise<RawFrontApp | null> {
  const mapped = mapFront(await runHelper(['front']))
  if (mapped) return mapped

  const bundleId = await runOsascript([
    'tell application "System Events" to get bundle identifier of first application process whose frontmost is true'
  ])
  if (!bundleId) return null
  const name = await runOsascript([
    `tell application "System Events" to get name of first application process whose bundle identifier is "${bundleId.replace(/"/g, '')}"`
  ])
  const pidRaw = await runOsascript([
    `tell application "System Events" to get unix id of first application process whose bundle identifier is "${bundleId.replace(/"/g, '')}"`
  ])
  const pid = pidRaw ? Number(pidRaw) : Number.NaN
  return {
    bundleId,
    name: name || bundleId,
    pid: Number.isFinite(pid) ? pid : 0,
    windowId: null,
    windowTitle: null,
    bounds: null,
    accessibility: false
  }
}

/**
 * Which application is in front, without its window.
 *
 * The window half of `front` costs a cold Accessibility round trip (35-45 ms)
 * plus an enumeration of every on-screen window. Callers that only need the
 * identity of the application — the plan's working app, a launch check, a focus
 * guard — should not pay for a fact they do not read, and most of them do not.
 */
export async function helperFrontApplication(): Promise<RawFrontApp | null> {
  return mapFront(await runHelper(['front-quick']))
}

/** What an application launch reported: enough to verify it against the screen. */
export interface HelperLaunched {
  pid: number
  bundleId: string
  name: string
}

/**
 * Opens an application by name, starting it if it is not already running.
 *
 * Returns what came forward, so the caller can check the screen instead of
 * trusting the call: a launch that reports success but leaves another window in
 * front is a failed step, not a completed one.
 */
export async function helperLaunch(name: string, signal?: AbortSignal): Promise<HelperLaunched | null> {
  if (!name) return null
  const payload = await runHelper(['launch', name], LAUNCH_TIMEOUT_MS, signal)
  if (!payload?.ok) return null
  return {
    pid: Number(payload.pid) || 0,
    bundleId: typeof payload.bundleId === 'string' ? payload.bundleId : '',
    name: typeof payload.name === 'string' ? payload.name : ''
  }
}

/** Brings a previously remembered application back to the front. */
export async function helperActivate(target: { bundleId: string; pid: number }, signal?: AbortSignal): Promise<boolean> {
  if (signal) {
    // Agent activation is bound to a specific process and cannot fall back to
    // an uncancellable AppleScript.
    return target.pid > 0 && (await runHelper(['activate', String(target.pid)], HELPER_TIMEOUT_MS, signal))?.ok === true
  }
  const byBundle = target.bundleId ? await runHelper(['activate', target.bundleId]) : null
  if (byBundle?.ok) return true
  if (target.pid > 0) {
    const byPid = await runHelper(['activate', String(target.pid)])
    if (byPid?.ok) return true
  }
  if (!target.bundleId) return false
  const escaped = target.bundleId.replace(/"/g, '')
  const result = await runOsascript([`tell application id "${escaped}" to activate`])
  return result !== null
}

export interface RunningApp {
  bundleId: string
  name: string
}

/** Every regular (Dock-visible) app currently running, sorted by name. */
export async function helperRunningApps(): Promise<RunningApp[]> {
  const payload = await runHelper(['apps'])
  if (payload?.ok && Array.isArray(payload.apps)) {
    return (payload.apps as Array<Record<string, unknown>>)
      .map((app) => ({
        bundleId: typeof app.bundleId === 'string' ? app.bundleId : '',
        name: typeof app.name === 'string' ? app.name : ''
      }))
      .filter((app) => app.bundleId && app.name)
  }

  const output = await runOsascript([
    'tell application "System Events" to get bundle identifier of every application process whose background only is false'
  ])
  if (!output) return []
  return output
    .split(',')
    .map((bundleId) => bundleId.trim())
    .filter(Boolean)
    .map((bundleId) => ({ bundleId, name: bundleId }))
}
