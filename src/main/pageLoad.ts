/**
 * Loads one renderer page into a window.
 *
 * Every renderer is its own Vite entry (`src/renderer/<page>/index.html`), so all
 * windows differ only in the page name. In dev the entry is served by the Vite
 * dev server; in a packaged build it is a file next to the compiled main bundle.
 *
 * This used to be copied into `windows.ts`, `pointer.ts` and `agent/cursor.ts`.
 * The copies were identical apart from the page name — `cursor.ts` had it baked
 * in — so there is one function now and the page is always a parameter.
 */

import { join } from 'node:path'
import type { BrowserWindow } from 'electron'

export function loadPage(win: BrowserWindow, page: string): void {
  const devServer = process.env['ELECTRON_RENDERER_URL']
  if (devServer) void win.loadURL(`${devServer}/${page}/index.html`)
  else void win.loadFile(join(__dirname, `../renderer/${page}/index.html`))
}
