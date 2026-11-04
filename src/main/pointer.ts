/**
 * The drawing layer: a transparent, click-through window pinned over the screen
 * that lets the assistant circle a button and point an arrow at it while it
 * explains — the "показать, а не написать" half of the assistant.
 *
 * Three properties matter, and all three are easy to get wrong:
 *
 * 1. It must never take focus. The user is usually about to click the thing we
 *    are pointing at, so `focusable: false` plus `showInactive()` keeps their
 *    app frontmost. A normal window would steal the keyboard on every answer.
 * 2. It must never eat clicks. `setIgnoreMouseEvents(true)` makes the layer
 *    transparent to the mouse, so "нажми сюда" actually works.
 * 3. It must sit above everything, including full-screen apps, without showing
 *    up in the window switcher.
 *
 * Coordinates arrive normalised (0..1) against the screenshot the model saw. The
 * layer is positioned over the very rectangle that screenshot covers, so mapping
 * is one multiply by the layer size — no Retina, no scale factor, no guessing.
 */

import { join } from 'node:path'
import { BrowserWindow, shell } from 'electron'
import { CH } from '@shared/ipc'
import type { Annotation, PointerPayload, PointerShape, ScreenRect } from '@shared/types'

let pointerWindow: BrowserWindow | null = null
let visible = false
let revision = 0
let ready: Promise<void> | null = null

/** Where the layer currently sits; re-positioning on every draw would flicker. */
let placedOn: ScreenRect | null = null

function loadPage(win: BrowserWindow, page: string): void {
  const devServer = process.env['ELECTRON_RENDERER_URL']
  if (devServer) void win.loadURL(`${devServer}/${page}/index.html`)
  else void win.loadFile(join(__dirname, `../renderer/${page}/index.html`))
}

function createWindow(): BrowserWindow {
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
    acceptFirstMouse: true,
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
  // The pointer must never appear in the next screenshot: it would feed our own
  // circles back into the model, and it would be photographed if the window
  // happens to sit behind the layer.
  win.setContentProtection(true)

  win.on('closed', () => {
    pointerWindow = null
    visible = false
    placedOn = null
    ready = null
  })

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  loadPage(win, 'pointer')
  return win
}

/**
 * Resolves once the layer's page can receive messages.
 *
 * Bounded on purpose: a page that never loads (a broken bundle, a dev server that
 * is restarting) would otherwise leave the painting chain awaiting a promise that
 * never settles, and nothing would ever be drawn again in this session.
 */
function ensureWindow(): Promise<void> {
  if (!pointerWindow || pointerWindow.isDestroyed()) {
    const win = createWindow()
    pointerWindow = win
    ready = new Promise<void>((resolve) => {
      let settled = false
      const done = (): void => {
        if (settled) return
        settled = true
        resolve()
      }
      win.webContents.once('did-finish-load', done)
      win.webContents.once('did-fail-load', done)
      // `send` before the first paint is harmless — it is queued — so a short cap
      // is enough to break a deadlock without delaying the common path.
      setTimeout(done, 1500)
    })
  }
  return ready ?? Promise.resolve()
}

function sameRect(a: ScreenRect | null, b: ScreenRect): boolean {
  if (!a) return false
  return (
    Math.round(a.x) === Math.round(b.x) &&
    Math.round(a.y) === Math.round(b.y) &&
    Math.round(a.width) === Math.round(b.width) &&
    Math.round(a.height) === Math.round(b.height)
  )
}

function placeOn(win: BrowserWindow, area: ScreenRect): void {
  if (sameRect(placedOn, area)) return
  const next: ScreenRect = {
    x: Math.round(area.x),
    y: Math.round(area.y),
    width: Math.round(area.width),
    height: Math.round(area.height)
  }
  win.setBounds(next)
  placedOn = next
}

/** Scales normalised coordinates onto the layer's own points. */
function toShapes(annotations: Annotation[], width: number, height: number): PointerShape[] {
  return annotations.map((annotation, index) => {
    const x1 = annotation.from.x * width
    const y1 = annotation.from.y * height
    const x2 = annotation.to.x * width
    const y2 = annotation.to.y * height

    if (annotation.kind === 'arrow' || annotation.kind === 'underline') {
      return {
        id: `${index}`,
        kind: annotation.kind,
        from: { x: x1, y: y1 },
        to: { x: x2, y: y2 },
        label: annotation.label
      }
    }

    // A circle or a box given as a single point becomes a visible minimum ring
    // around the target instead of an invisible dot.
    const minRadius = 16
    const padding = 6
    const cx = (x1 + x2) / 2
    const cy = (y1 + y2) / 2
    const radiusX = Math.max(Math.abs(x2 - x1) / 2, minRadius)
    const radiusY = Math.max(Math.abs(y2 - y1) / 2, minRadius)
    return {
      id: `${index}`,
      kind: annotation.kind,
      from: {
        x: Math.max(0, cx - radiusX - padding),
        y: Math.max(0, cy - radiusY - padding)
      },
      to: {
        x: Math.min(width, cx + radiusX + padding),
        y: Math.min(height, cy + radiusY + padding)
      },
      label: annotation.label
    }
  })
}

/** Draws `annotations` over the screen and makes the layer visible. */
export async function showAnnotations(area: ScreenRect, annotations: Annotation[]): Promise<void> {
  if (annotations.length === 0) {
    hideAnnotations()
    return
  }
  await ensureWindow()
  const win = pointerWindow
  if (!win || win.isDestroyed()) return

  placeOn(win, area)
  revision += 1

  const payload: PointerPayload = {
    width: Math.round(area.width),
    height: Math.round(area.height),
    revision,
    visible: true,
    shapes: toShapes(annotations, area.width, area.height)
  }

  win.webContents.send(CH.pointer.draw, payload)
  if (!visible) {
    visible = true
    // showInactive: keep the user's app frontmost — this is the whole point.
    win.showInactive()
  }
}

export function hideAnnotations(): void {
  visible = false
  const win = pointerWindow
  if (!win || win.isDestroyed()) return
  const payload: PointerPayload = {
    width: placedOn?.width ?? 0,
    height: placedOn?.height ?? 0,
    revision,
    visible: false,
    shapes: []
  }
  win.webContents.send(CH.pointer.draw, payload)
  // Let the renderer play its fade-out before the window disappears.
  setTimeout(() => {
    if (pointerWindow && !pointerWindow.isDestroyed() && !visible) pointerWindow.hide()
  }, 240)
}

export function isPointerVisible(): boolean {
  return visible
}

export function destroyPointer(): void {
  visible = false
  placedOn = null
  ready = null
  if (pointerWindow && !pointerWindow.isDestroyed()) pointerWindow.destroy()
  pointerWindow = null
}
