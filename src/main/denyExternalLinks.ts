/**
 * Denies every in-window navigation: a link in a renderer must open in the
 * user's browser, never replace the app's own page.
 *
 * Four windows used to carry this four-line handler inline, and the copies had
 * already drifted: `agent/cursor.ts` matched `^https?:\/\//i`, the other three
 * had no `i` flag, so `HTTPS://…` opened from the agent's window and did nothing
 * anywhere else. The flag is a parameter here, not a decision — unifying it is a
 * behaviour change and is tracked separately.
 */

import { shell } from 'electron'
import type { BrowserWindow } from 'electron'

export interface DenyExternalLinksOptions {
  /**
   * Match the scheme case-insensitively. Only `agent/cursor.ts` passes `true`,
   * which is what it did before the extraction; the other three windows keep
   * their case-sensitive regex.
   */
  matchSchemeCaseInsensitively?: boolean
}

/** `^https?://` matched case-insensitively: the agent's cursor layer accepts `HTTPS://`. */
const ANY_CASE_SCHEME = /^https?:\/\//i
/** The same pattern case-sensitively, which is what the three app windows kept. */
const EXACT_CASE_SCHEME = /^https?:\/\//

export function denyExternalLinks(
  win: BrowserWindow,
  options: DenyExternalLinksOptions = {}
): void {
  const pattern = options.matchSchemeCaseInsensitively ? ANY_CASE_SCHEME : EXACT_CASE_SCHEME
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (pattern.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
}
