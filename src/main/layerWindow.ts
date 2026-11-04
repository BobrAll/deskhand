/**
 * Creates one of the two "layer" windows: the drawing layer (`pointer.ts`) and
 * the agent's cursor highlight (`agent/cursor.ts`).
 *
 * Both windows are pictures pinned over the screen, not windows the user
 * interacts with, and both spell out the same three properties — which are
 * exactly the properties that are easy to lose in a refactor:
 *
 * 1. It must never take focus: `focusable: false` (plus `showInactive()` in the
 *    callers). A normal window would steal the keyboard on every answer.
 * 2. It must never eat clicks: `setIgnoreMouseEvents(true, { forward: true })`,
 *    so "нажми сюда" actually works on whatever is underneath.
 * 3. It must sit above everything, including full-screen apps, without showing
 *    up in the window switcher.
 *
 * And one more that is specific to these two: the layer must never be
 * photographed into the next screenshot, so `setContentProtection(true)` —
 * otherwise our own ring or circles come back to the model as content, and
 * worse, as a target.
 *
 * What stays a parameter, because it is a decision and not boilerplate:
 * `acceptFirstMouse` (the drawing layer takes the first click, the ring does
 * not), the `/i` flag of the link handler (`agent/cursor.ts` has it, the others
 * do not — see `denyExternalLinks.ts`) and the module-specific `closed` reset.
 */

import { join } from 'node:path'
import { BrowserWindow } from 'electron'
import { denyExternalLinks } from './denyExternalLinks'
import { loadPage } from './pageLoad'

export interface LayerWindowOptions {
  /** Renderer entry to load: `'pointer'` or `'cursor'`. */
  page: string
  /**
   * Whether the layer accepts the first click. `pointer.ts` passes `true`,
   * `agent/cursor.ts` passes `false`; the values are not unified.
   */
  acceptFirstMouse: boolean
  /** Case-insensitive `^https?:\/\/` in the window-open handler. */
  caseless?: boolean
  /** Runs on `closed`, after the window's own state has been dropped. */
  onClosed?: () => void
}

/** The window options and chrome shared by both layers. */
export function createLayerWindow(options: LayerWindowOptions): BrowserWindow {
  const win = new BrowserWindow({
    x: 0,
    y: 0,
    width: 400,
    height: 300,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    // These two turn it into a painting layer instead of a window: it cannot be
    // focused (so it never activates the app) and it skips the window switcher.
    focusable: false,
    skipTaskbar: true,
    acceptFirstMouse: options.acceptFirstMouse,
    roundedCorners: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  // Clicks, drags and scrolls belong to whatever is underneath.
  win.setIgnoreMouseEvents(true, { forward: true })
  // 'screen-saver' is the level above full-screen apps and the Dock.
  win.setAlwaysOnTop(true, 'screen-saver')
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  win.setContentProtection(true)

  if (options.onClosed) win.on('closed', options.onClosed)

  denyExternalLinks(win, { caseless: options.caseless })
  loadPage(win, options.page)

  return win
}
