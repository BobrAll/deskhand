/** Resolves files shipped in `resources/` for both dev and packaged builds. */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'

/**
 * Where a shipped file may be, in the order it is looked for.
 *
 * Four places in main resolve a bundled binary, and each had its own copy of
 * this packaged/dev branch. The copies had already drifted: the agent also looks
 * in its Swift build directory, whisper also looks in Homebrew. Those extra
 * places are what `extra` is for — the rule that a packaged build only has
 * `resources/`, and that a dev checkout looks in the app and then in the working
 * directory, is the same rule everywhere and belongs in one place.
 *
 * What each caller does when nothing is found is deliberately *not* shared:
 * `resourcePath` returns a path anyway (the tray draws an empty image for a file
 * that is absent), `native/process.ts` and `agent/sidecar.ts` return `null` and
 * warn, and `voice/recognizer.ts` simply returns `null`. Forcing one of those on
 * the other two would change behaviour.
 */
export function resourceCandidates(name: string, extra: string[] = []): string[] {
  if (app.isPackaged) return [join(process.resourcesPath, name)]
  return [
    join(app.getAppPath(), 'resources', name),
    ...extra,
    join(process.cwd(), 'resources', name)
  ]
}

/**
 * Finds one shipped file, packaged or in dev.
 *
 * Returns a path even when nothing exists: its callers — the tray and window
 * images — take a path and draw an empty image for a file that is absent.
 */
export function resourcePath(name: string): string {
  const candidates = resourceCandidates(name)
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]
}
