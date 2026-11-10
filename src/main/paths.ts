/** Resolves files shipped in `resources/` for both dev and packaged builds. */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'

/**
 * Finds one shipped file, packaged or in dev.
 *
 * Main has three such candidate lists, and they are deliberately not one:
 * `native/process.ts` returns `null` when the helper binary is missing (the
 * caller then falls back to `osascript`) and warns; `voice/recognizer.ts` appends
 * the Homebrew `whisper-cli` locations after the bundled ones, because a user may
 * already have installed it; this one returns a path even when nothing exists,
 * because its callers — the tray and window images — take a path and draw an empty
 * image for a file that is absent. Unifying the lists would force one of those
 * three behaviours on the other two.
 */
export function resourcePath(name: string): string {
  const candidates = app.isPackaged
    ? [join(process.resourcesPath, name)]
    : [join(app.getAppPath(), 'resources', name), join(process.cwd(), 'resources', name)]
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]
}