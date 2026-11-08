/**
 * Bridge to the small ObjC helper that ships with the app.
 *
 * Electron cannot (a) reliably synthesize Cmd+C/Cmd+V into a *foreign*
 * application, (b) enumerate the focused window of another process, or
 * (c) query the TCC permission state. The helper covers exactly those gaps.
 * Context and clipboard helpers can fall back to osascript. Agent input
 * requires the native binary.
 */

import { trace, traceEnd } from '../agent/trace'
import { execFile, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { join } from 'node:path'
import { app } from 'electron'
import type { AxElementInfo, AxProbe, PermissionState } from '@shared/types'

export interface RawFrontApp {
  bundleId: string
  name: string
  pid: number
  windowId: number | null
  windowTitle: string | null
  bounds: { x: number; y: number; width: number; height: number } | null
  accessibility: boolean
}

interface HelperPayload {
  ok?: boolean
  error?: string
  [key: string]: unknown
}

const HELPER_NAME = 'smartcursor-helper'
let cachedHelperPath: string | null | undefined

function resolveHelperPath(): string | null {
  if (cachedHelperPath !== undefined) return cachedHelperPath
  const candidates = app.isPackaged
    ? [join(process.resourcesPath, HELPER_NAME)]
    : [
        join(app.getAppPath(), 'resources', HELPER_NAME),
        join(process.cwd(), 'resources', HELPER_NAME)
      ]
  cachedHelperPath = candidates.find((candidate) => existsSync(candidate)) ?? null
  if (!cachedHelperPath) {
    console.warn('[native] helper binary not found, falling back to osascript')
  }
  return cachedHelperPath
}

/** Path to the helper binary, or null when it was not built into the bundle. */
export function helperBinary(): string | null {
  return resolveHelperPath()
}

function runHelper(args: string[], timeoutMs = 4000, signal?: AbortSignal): Promise<HelperPayload | null> {
  const binary = resolveHelperPath()
  if (!binary || signal?.aborted) return Promise.resolve(null)
  const command = args[0] === 'input' ? args[4] : args[0]
  const end = traceEnd('helper', { command })
  return new Promise((resolve) => {
    // Wait for process close instead of using execFile's AbortSignal: its
    // callback can fire before the helper releases a held key or button.
    const child = execFile(binary, args, { ...(signal ? {} : { timeout: timeoutMs }), maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
      clearTimeout(timer)
      clearTimeout(force)
      signal?.removeEventListener('abort', cancel)
      end()
      if (error) {
        trace('helper.error', { command, killed: error.killed === true })
        resolve(null)
        return
      }
      try {
        const payload = JSON.parse(stdout.trim()) as HelperPayload
        if (command === 'probe' && typeof payload.elapsedMs === 'number') {
          trace('ax.native', { durationMs: Math.round(payload.elapsedMs) })
        }
        if (command === 'click' && typeof payload.pressMs === 'number' && typeof payload.releaseMs === 'number') {
          trace('click.native', { pressMs: payload.pressMs, releaseMs: payload.releaseMs })
        }
        resolve(payload)
      } catch {
        resolve(null)
      }
    })
    let force: ReturnType<typeof setTimeout> | undefined
    const cancel = (): void => {
      if (force) return
      child.kill('SIGTERM')
      force = setTimeout(() => child.kill('SIGKILL'), 1500)
    }
    const timer = signal ? setTimeout(cancel, timeoutMs) : undefined
    signal?.addEventListener('abort', cancel, { once: true })
  })
}

function runOsascript(lines: string[], timeoutMs = 4000): Promise<string | null> {
  const args = lines.flatMap((line) => ['-e', line])
  return new Promise((resolve) => {
    execFile('osascript', args, { timeout: timeoutMs }, (error, stdout) => {
      if (error) {
        resolve(null)
        return
      }
      resolve(stdout.trim())
    })
  })
}

function numberOf(value: unknown): number | null {
  if (value == null) return null
  const num = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(num) ? num : null
}

function mapBounds(raw: unknown): RawFrontApp['bounds'] {
  if (typeof raw !== 'object' || raw === null) return null
  const source = raw as Record<string, unknown>
  const x = numberOf(source.X ?? source.x)
  const y = numberOf(source.Y ?? source.y)
  const width = numberOf(source.Width ?? source.width)
  const height = numberOf(source.Height ?? source.height)
  if (x === null || y === null || width === null || height === null) return null
  return { x, y, width, height }
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
export async function helperFront(): Promise<RawFrontApp | null> {
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
  const payload = await runHelper(['launch', name], 15_000, signal)
  if (!payload?.ok) return null
  return {
    pid: Number(payload.pid) || 0,
    bundleId: typeof payload.bundleId === 'string' ? payload.bundleId : '',
    name: typeof payload.name === 'string' ? payload.name : ''
  }
}

export async function helperOpenBrowser(signal?: AbortSignal): Promise<string | null> {
  const payload = await runHelper(['open-browser'], 4000, signal)
  return payload?.ok && typeof payload.bundleId === 'string' ? payload.bundleId : null
}

/** Brings a previously remembered application back to the front. */
export async function helperActivate(target: { bundleId: string; pid: number }, signal?: AbortSignal): Promise<boolean> {
  if (signal) {
    // Agent activation is bound to a specific process and cannot fall back to
    // an uncancellable AppleScript.
    return target.pid > 0 && (await runHelper(['activate', String(target.pid)], 4000, signal))?.ok === true
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

// ---------------------------------------------------------------------------
// Agent: posting input into the frontmost application
//
// Every function here needs the Accessibility grant; the helper answers with
// `accessibility-denied` otherwise and the caller turns that into a message the
// user can act on. `false` may mean partial input or an unknown effect.

export interface NativeInputTarget {
  pid: number
  windowId: number | null
  bounds: RawFrontApp['bounds']
  signal: AbortSignal
}

function runInput(args: string[], target?: NativeInputTarget, timeout = 4000) {
  const bounds = target?.bounds
  const geometry = bounds ? [bounds.x, bounds.y, bounds.width, bounds.height].join(',') : '-'
  return runHelper(target ? ['input', String(target.pid), String(target.windowId ?? 0), geometry, ...args] : args,
    timeout, target?.signal)
}
// ---------------------------------------------------------------------------

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
  const timeout = Math.min(30_000, 4_000 + text.length * 40)
  const payload = await runInput(['type', encoded], target, timeout)
  return payload?.ok === true
}

/** Presses one key with a modifier mask (shortcuts, Return, Tab, arrows). */
export async function helperPressKey(keyCode: number, flags: number, target?: NativeInputTarget): Promise<boolean> {
  const payload = await runInput(['key', String(keyCode), String(flags)], target)
  return payload?.ok === true
}

/** True for the JSON shape a boolean can arrive in: `@(expr)` may serialise as 1. */
function flag(value: unknown): boolean {
  return value === true || value === 1
}

function mapAxElement(raw: unknown): AxElementInfo | null {
  if (typeof raw !== 'object' || raw === null) return null
  const source = raw as Record<string, unknown>
  const role = typeof source.role === 'string' ? source.role : ''
  if (!role) return null
  const element: AxElementInfo = {
    role,
    frame: mapBounds(source.frame),
    pressable: flag(source.pressable),
    editable: flag(source.editable)
  }
  if (typeof source.subrole === 'string') element.subrole = source.subrole
  if (typeof source.title === 'string') element.title = source.title
  if (typeof source.value === 'string') element.value = source.value
  if (typeof source.description === 'string') element.description = source.description
  if (typeof source.help === 'string') element.help = source.help
  if (typeof source.roleDescription === 'string') element.roleDescription = source.roleDescription
  const depth = numberOf(source.depth)
  if (depth !== null) element.depth = depth
  const pid = numberOf(source.pid)
  if (pid !== null) element.pid = pid
  if (Array.isArray(source.actions)) {
    element.actions = source.actions.filter((name): name is string => typeof name === 'string')
  }
  return element
}

/**
 * The element that has the keyboard, or null when Accessibility cannot say.
 *
 * Checked before typing: the plan is "click the field, then type", and a click
 * that landed next to a small field would otherwise deliver the text to whatever
 * is actually focused. One round trip, not a tree walk — the check runs on the
 * path of every keystroke.
 */
export async function helperFocused(pid: number | null): Promise<AxElementInfo | null> {
  const payload = await runHelper(['focused', String(pid !== null && pid > 0 ? Math.round(pid) : 0)])
  if (!payload?.ok) return null
  return mapAxElement(payload.focused)
}

/**
 * Asks the Accessibility API where things are.
 *
 * `point` is the model's guess: the helper reports the element under it (and its
 * ancestors) along with everything actionable in the focused window and the menu
 * bar, so the caller can tell "clicked the icon" from "clicked 20 points left of
 * the icon". Returns null when Accessibility is not granted or the helper is
 * missing, which the caller treats as "aim with the model's point".
 *
 * The native walk has its own 600 ms budget; the timeout here only covers a
 * target application that stops answering in the middle of it.
 */
export async function helperProbe(
  pid: number | null,
  point?: { x: number; y: number } | null
): Promise<AxProbe | null> {
  const args = ['probe', String(pid !== null && pid > 0 ? Math.round(pid) : 0)]
  if (point) args.push(String(Math.round(point.x)), String(Math.round(point.y)))
  const payload = await runHelper(args, 3000)
  if (!payload?.ok) return null
  const probePid = numberOf(payload.pid)
  if (probePid === null) return null
  const list = (value: unknown): AxElementInfo[] =>
    Array.isArray(value)
      ? value
          .map(mapAxElement)
          .filter((element): element is AxElementInfo => element !== null && element.frame != null)
      : []
  return {
    pid: probePid,
    app: typeof payload.app === 'string' ? payload.app : '',
    chain: list(payload.chain),
    targets: list(payload.targets),
    focused: mapAxElement(payload.focused),
    elapsedMs: numberOf(payload.elapsedMs) ?? 0
  }
}

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
  const binary = resolveHelperPath()
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
 * Current permission state; `request` triggers the macOS prompts.
 *
 * The microphone is not in the result: it is a per-process TCC grant that only
 * Electron's own `systemPreferences` can ask for, so `permissions.ts` fills it in.
 */
export async function helperPermissions(
  request: boolean
): Promise<Pick<PermissionState, 'accessibility' | 'screenRecording'> | null> {
  const payload = await runHelper([request ? 'request-permissions' : 'permissions'])
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