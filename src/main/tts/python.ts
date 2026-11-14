/**
 * Python discovery for the optional Silero engine.
 *
 * Silero lives in its own virtual environment; it is not bundled with the app.
 * Finder-launched apps do not inherit a login PATH, so the interpreter is looked
 * up in the usual Homebrew and system locations instead of relying on `python3`
 * resolving.
 */

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'

/** Direct Homebrew and system paths: a packaged app has no login PATH. */
const PYTHON_CANDIDATES = [
  '/opt/homebrew/bin/python3.12',
  '/opt/homebrew/bin/python3.13',
  '/opt/homebrew/bin/python3',
  '/usr/local/bin/python3.12',
  '/usr/local/bin/python3.13',
  '/usr/local/bin/python3',
  '/usr/bin/python3'
]

const LINE_CHARS = 300

/**
 * The first non-empty line of the given lines, trimmed and clipped.
 *
 * Python puts the useful line at one end: the first for a failed command, the
 * last for a traceback.
 */
function edgeLine(lines: string[]): string {
  return lines.find((line) => line.trim())?.trim().slice(0, LINE_CHARS) ?? ''
}

export function firstLine(text: string): string {
  return edgeLine(text.split('\n'))
}

/** The last non-empty line: where Python puts the exception, not the traceback header. */
export function lastLine(text: string): string {
  return edgeLine(text.split('\n').reverse())
}

/** Runs a command to completion; the first stderr line becomes the error. */
export function run(command: string, args: string[], timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (error, _stdout, stderr) => {
      if (!error) return resolve()
      const detail = firstLine(String(stderr)) || error.message
      reject(new Error(detail))
    })
  })
}

/** A Python 3.12+ the packages can run on, or null when the machine has none. */
export async function findPython(): Promise<string | null> {
  for (const candidate of PYTHON_CANDIDATES) {
    if (!existsSync(candidate)) continue
    try {
      await run(candidate, ['-c', 'import sys; raise SystemExit(0 if sys.version_info >= (3, 12) else 1)'], 10_000)
      return candidate
    } catch {
      // Not this one; an older Homebrew python3 is the common case.
    }
  }
  return null
}
