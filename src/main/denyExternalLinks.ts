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

import { normalize, join, sep } from 'node:path'
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

/**
 * Where the build puts the app's own pages, next to the main bundle.
 *
 * `file:` alone proves nothing: every local file has that scheme, and a window
 * that navigates to one keeps its preload — the deskhand API exposed to the
 * renderer. Only the renderer directory is the app.
 */
const RENDERER_DIR = join(__dirname, '../renderer')

/**
 * Whether a URL is one of the app's own pages.
 *
 * The renderers are loaded from the renderer directory in a packaged build and
 * from the Vite dev server otherwise; anything else is a web page or a foreign
 * file, not the app. For `file:` URLs `normalize` folds `..`, so a crafted path
 * cannot climb out of the renderer directory once the percent-encoded segments
 * are decoded.
 */
function isAppPage(url: string): boolean {
  const devServer = process.env['ELECTRON_RENDERER_URL']
  try {
    const parsed = new URL(url)
    if (parsed.protocol === 'file:') {
      return normalize(decodeURIComponent(parsed.pathname)).startsWith(`${RENDERER_DIR}${sep}`)
    }
    return devServer !== undefined && parsed.origin === new URL(devServer).origin
  } catch {
    return false
  }
}

export function denyExternalLinks(win: BrowserWindow, options: DenyExternalLinksOptions = {}): void {
  const pattern = options.matchSchemeCaseInsensitively ? ANY_CASE_SCHEME : EXACT_CASE_SCHEME
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (pattern.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  // `setWindowOpenHandler` only sees a new window: a link dragged onto the page,
  // or an anchor without `target="_blank"`, is an ordinary navigation that
  // replaces the app's own page and leaves no way back. Deny it the same way,
  // and hand only a real http(s) link to the browser.
  win.webContents.on('will-navigate', (event, url) => {
    if (isAppPage(url)) return
    event.preventDefault()
    if (pattern.test(url)) void shell.openExternal(url)
  })
}
