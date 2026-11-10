/**
 * Locating and running the small ObjC helper that ships with the app.
 *
 * Electron cannot (a) reliably synthesize Cmd+C/Cmd+V into a *foreign*
 * application, (b) enumerate the focused window of another process, or
 * (c) query the TCC permission state. The helper covers exactly those gaps.
 * Context and clipboard helpers can fall back to osascript. Agent input
 * requires the native binary.
 *
 * This module is the process half: where the binary lives, the one `execFile`
 * wrapper that traces and cancels it, and the osascript fallback. What the
 * helper is asked to do lives in `ax.ts`, `input.ts` and `apps.ts`.
 */

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { trace, traceEnd } from '../agent/trace'
import { resourceCandidates } from '../paths'

export interface HelperPayload {
  ok?: boolean
  error?: string
  [key: string]: unknown
}

/** Default ceiling for one helper call. */
export const HELPER_TIMEOUT_MS = 4000
/** How long a cancelled call waits for SIGTERM before it is killed outright. */
const KILL_GRACE_MS = 1500
/** A probe payload can carry a whole window's worth of elements. */
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024

const HELPER_NAME = 'deskhand-helper'
let cachedHelperPath: string | null | undefined

function resolveHelperPath(): string | null {
  if (cachedHelperPath !== undefined) return cachedHelperPath
  const candidates = resourceCandidates(HELPER_NAME)
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

export function runHelper(
  args: string[],
  timeoutMs = HELPER_TIMEOUT_MS,
  signal?: AbortSignal
): Promise<HelperPayload | null> {
  const binary = resolveHelperPath()
  if (!binary || signal?.aborted) return Promise.resolve(null)
  const command = args[0] === 'input' ? args[4] : args[0]
  const end = traceEnd('helper', { command })
  return new Promise((resolve) => {
    // Wait for process close instead of using execFile's AbortSignal: its
    // callback can fire before the helper releases a held key or button.
    const child = execFile(binary, args, { ...(signal ? {} : { timeout: timeoutMs }), maxBuffer: MAX_OUTPUT_BYTES }, (error, stdout) => {
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
      force = setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS)
    }
    const timer = signal ? setTimeout(cancel, timeoutMs) : undefined
    signal?.addEventListener('abort', cancel, { once: true })
  })
}

export function runOsascript(
  lines: string[],
  timeoutMs = HELPER_TIMEOUT_MS
): Promise<string | null> {
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

export function numberOf(value: unknown): number | null {
  if (value == null) return null
  const num = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(num) ? num : null
}

export function mapBounds(raw: unknown): { x: number; y: number; width: number; height: number } | null {
  if (typeof raw !== 'object' || raw === null) return null
  const source = raw as Record<string, unknown>
  const x = numberOf(source.X ?? source.x)
  const y = numberOf(source.Y ?? source.y)
  const width = numberOf(source.Width ?? source.width)
  const height = numberOf(source.Height ?? source.height)
  if (x === null || y === null || width === null || height === null) return null
  return { x, y, width, height }
}

/** True for the JSON shape a boolean can arrive in: `@(expr)` may serialise as 1. */
export function flag(value: unknown): boolean {
  return value === true || value === 1
}
