/**
 * Creates one of the "layer" windows: the drawing layer (`pointer.ts`), the
 * agent's cursor highlight (`agent/cursor.ts`) and the agent's virtual pointer
 * (`agent/presentation.ts`).
 *
 * All three windows are pictures pinned over the screen, not windows the user
 * interacts with, and all three spell out the same three properties — which are
 * exactly the properties that are easy to lose in a refactor:
 *
 * 1. It must never take focus: `focusable: false` (plus `showInactive()` in the
 *    callers). A normal window would steal the keyboard on every answer.
 * 2. It must never eat clicks: `setIgnoreMouseEvents(true, { forward: true })`,
 *    so "нажми сюда" actually works on whatever is underneath.
 * 3. It must sit above everything, including full-screen apps, without showing
 *    up in the window switcher.
 *
 * And one more that is specific to all three: the layer must never be
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
import type { ScreenRect } from '@shared/types'
import { denyExternalLinks } from './denyExternalLinks'
import { loadPage } from './pageLoad'

/** How long to wait for a layer's page before painting anyway. */
const LOAD_TIMEOUT_MS = 1500

export interface LayerWindowOptions {
  /** Renderer entry to load: `'pointer'`, `'cursor'` or `'presenter'`. */
  page: string
  /**
   * Whether the layer accepts the first click. `pointer.ts` passes `true`;
   * the agent's two layers pass `false`. The values are not unified.
   */
  acceptFirstMouse: boolean
  /** Case-insensitive `^https?:\/\/` in the window-open handler. */
  caseless?: boolean
  /** Runs on `closed`, after the window's own state has been dropped. */
  onClosed?: () => void
}

/** The window options and chrome shared by every layer. */
export function createLayerWindow(options: LayerWindowOptions): BrowserWindow {
  const win = new BrowserWindow({
    // A placeholder until the caller places the layer over the display it
    // belongs to; the window is never shown before that happens.
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

/**
 * The window and its one-shot load promise, as each layer keeps them.
 *
 * Kept in one object because `ensureLayerWindow` updates both: a window without
 * its promise would be awaited forever, and a promise without its window is what
 * a closed layer leaves behind.
 */
export interface LayerWindowState {
  window: BrowserWindow | null
  /** Resolves once the page can receive messages; null before the first create. */
  loaded: Promise<void> | null
}

export interface EnsureLayerWindowOptions {
  /** How long to wait for the page; defaults to `LOAD_TIMEOUT_MS`. */
  timeoutMs?: number
  /**
   * Resolve the wait on `destroyed` as well as on load.
   *
   * The agent's two layers wait for it; the drawing layer does not, because it
   * checks the window itself once the wait is over. The difference is preserved
   * rather than unified.
   */
  watchDestroyed?: boolean
}

/**
 * Creates the layer's window on first use, or reuses the live one, and resolves
 * once its page can receive messages.
 *
 * Bounded on purpose: a page that never loads (a broken bundle, a dev server that
 * is restarting) would otherwise leave the painting chain awaiting a promise that
 * never settles, and nothing would ever be drawn again in this session. A message
 * sent before the load is queued by Electron, so the bound only breaks a deadlock,
 * it does not delay the common path.
 *
 * Resolves null when the window went away while loading: the caller must not
 * paint into a window that no longer exists.
 */
export function ensureLayerWindow(
  state: LayerWindowState,
  create: () => BrowserWindow,
  options: EnsureLayerWindowOptions = {}
): Promise<BrowserWindow | null> {
  const stillOpen = (): BrowserWindow | null =>
    state.window && !state.window.isDestroyed() ? state.window : null

  const live = state.window
  if (live && !live.isDestroyed() && state.loaded) return state.loaded.then(stillOpen)

  const created = create()
  state.window = created
  const loaded = new Promise<void>((resolve) => {
    let settled = false
    const done = (): void => {
      if (settled) return
      settled = true
      resolve()
    }
    created.webContents.once('did-finish-load', done)
    created.webContents.once('did-fail-load', done)
    if (options.watchDestroyed) created.webContents.once('destroyed', done)
    setTimeout(done, options.timeoutMs ?? LOAD_TIMEOUT_MS)
  })
  state.loaded = loaded
  return loaded.then(stillOpen)
}

/**
 * Whether the layer already sits where it is being put.
 *
 * `round` is not a preference: the drawing layer rounds the rectangle it is
 * given (a capture area can be fractional) before comparing and before applying
 * it, while the agent's two layers compare and apply display bounds as they are.
 */
export function sameScreenRect(a: ScreenRect | null, b: ScreenRect, round = false): boolean {
  if (!a) return false
  if (!round) {
    return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
  }
  return (
    Math.round(a.x) === Math.round(b.x) &&
    Math.round(a.y) === Math.round(b.y) &&
    Math.round(a.width) === Math.round(b.width) &&
    Math.round(a.height) === Math.round(b.height)
  )
}

/** A rectangle in whole points. */
function roundScreenRect(rect: ScreenRect): ScreenRect {
  return {
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    width: Math.round(rect.width),
    height: Math.round(rect.height)
  }
}

export interface LayerPlacement {
  /** What the layer is now placed on; unchanged when it did not move. */
  placedOn: ScreenRect | null
  /** Whether the window was moved. */
  moved: boolean
}

/**
 * Puts the layer over `bounds`, unless it is already there.
 *
 * Returns the new `placedOn` instead of writing module state, so every caller
 * keeps its own. `round` preserves the drawing layer's rounding; see
 * `sameScreenRect`.
 */
export function placeLayer(
  win: BrowserWindow,
  placedOn: ScreenRect | null,
  bounds: ScreenRect,
  round = false
): LayerPlacement {
  if (sameScreenRect(placedOn, bounds, round)) return { placedOn, moved: false }
  const next = round ? roundScreenRect(bounds) : bounds
  win.setBounds(next)
  return { placedOn: next, moved: true }
}
