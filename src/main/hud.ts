/**
 * The cursor HUD: one small chip that appears at the pointer while the
 * microphone is open.
 *
 * The card is a separate window that can be pushed off to the side or behind
 * another window, and is not even on screen in dictation mode. The pointer is the
 * one thing that is always exactly where the user is looking, so the state is
 * mirrored there — and there *only*: the app has one voice indicator, this chip's
 * four bars. The card deliberately shows nothing while a turn runs.
 *
 * The three properties from `pointer.ts` apply unchanged, for the same reasons: it
 * must never take focus, never eat clicks and never appear in a screenshot the
 * model is shown. A HUD that stole the keyboard would break the very flow it is
 * describing.
 *
 * The layer is a window placed *around* the pointer rather than a full-screen
 * overlay: one tiny compositor layer instead of a display-sized one, and it keeps
 * the chip from being painted across the whole screen while a user speaks.
 */

import { join } from 'node:path'
import { BrowserWindow, screen, shell } from 'electron'
import { CH } from '@shared/ipc'
import type { HudFrame, HudSide, ScreenRect, VoiceEvent } from '@shared/types'

/**
 * Layer size, in points. It has to hold the widest chip the renderer can produce
 * on either side of the pointer, because the layer stays centred on the cursor and
 * only moves when the pointer itself moves. The chip is 40×22, so this is a
 * generous box around it — a transparent layer, but one the compositor still has
 * to keep around, so there is no reason to make it display-sized.
 */
const WIDTH = 320
const HEIGHT = 160

/** Space between the pointer and the chip, in points. Must match `GAP` in the renderer. */
const GAP = 16

/**
 * Chip metrics as the placement logic sees them. The renderer measures its own
 * chip (the bar count sets its width), so these only have to be close enough to
 * decide which side of the cursor has room.
 */
const CHIP_WIDTH = 40
const CHIP_HEIGHT = 22

/** Margin kept from the work-area edges when choosing a side. */
const EDGE = 8

/**
 * How long the renderer's fade-out runs before the window is actually hidden.
 * Kept in step with `hud-out` in `hud.css`.
 */
const EXIT_MS = 160

/** How long to wait for the page before painting anyway. */
const LOAD_TIMEOUT_MS = 1500

/** The last frame actually sent, reused for the fade-out. */
interface Shown {
  phase: 'listening' | 'transcribing'
  level: number
  anchor: { x: number; y: number }
  side: HudSide
}

export interface CursorHudOptions {
  /** The card's rectangle, so the chip is never placed underneath it. */
  avoid(): ScreenRect | null
}

export interface CursorHud {
  /**
   * Feeds one frame of the push-to-talk state. Called on phase changes and at
   * ~10 Hz while a turn runs, which is also what makes the bubble follow the
   * pointer — no separate polling loop is needed.
   */
  update(event: VoiceEvent): void
  /**
   * The frame most recently painted, for a bubble whose page is still loading.
   * The window is prewarmed, so the first press can arrive before the renderer
   * has subscribed; without this pull that turn would show an empty bubble.
   */
  getState(): HudFrame | null
  /** Builds the window ahead of the first press so the chip is instant. */
  prewarm(): void
  destroy(): void
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max))
}

function clamp01(value: number): number {
  return clamp(Number.isFinite(value) ? value : 0, 0, 1)
}

/** The rectangle the chip would occupy on screen for a given side. */
function chipRect(cursor: { x: number; y: number }, side: HudSide): ScreenRect {
  switch (side) {
    case 'above':
      return {
        x: cursor.x - CHIP_WIDTH / 2,
        y: cursor.y - GAP - CHIP_HEIGHT,
        width: CHIP_WIDTH,
        height: CHIP_HEIGHT
      }
    case 'right':
      return {
        x: cursor.x + GAP,
        y: cursor.y - CHIP_HEIGHT / 2,
        width: CHIP_WIDTH,
        height: CHIP_HEIGHT
      }
    case 'left':
      return {
        x: cursor.x - GAP - CHIP_WIDTH,
        y: cursor.y - CHIP_HEIGHT / 2,
        width: CHIP_WIDTH,
        height: CHIP_HEIGHT
      }
    case 'below':
    default:
      return {
        x: cursor.x - CHIP_WIDTH / 2,
        y: cursor.y + GAP,
        width: CHIP_WIDTH,
        height: CHIP_HEIGHT
      }
  }
}

function inside(rect: ScreenRect, area: ScreenRect, margin = EDGE): boolean {
  return (
    rect.x >= area.x + margin &&
    rect.y >= area.y + margin &&
    rect.x + rect.width <= area.x + area.width - margin &&
    rect.y + rect.height <= area.y + area.height - margin
  )
}

function overlaps(a: ScreenRect, b: ScreenRect, pad = 10): boolean {
  return (
    a.x < b.x + b.width + pad &&
    a.x + a.width + pad > b.x &&
    a.y < b.y + b.height + pad &&
    a.y + a.height + pad > b.y
  )
}

/**
 * Picks the side of the cursor the chip goes on.
 *
 * The card opens down-and-right of the pointer, so the naive "below" lands under
 * it; the first candidate that both fits on the display and clears the card wins,
 * and a side that merely fits is the fallback — a chip tucked under the card is
 * still better than one hanging off the screen.
 */
function pickSide(
  cursor: { x: number; y: number },
  area: ScreenRect,
  avoid: ScreenRect | null
): HudSide {
  const order: HudSide[] = ['below', 'right', 'above', 'left']
  const candidates = order.map((side) => ({ side, rect: chipRect(cursor, side) }))
  const clear = candidates.find(
    (candidate) => inside(candidate.rect, area) && !(avoid && overlaps(candidate.rect, avoid))
  )
  if (clear) return clear.side
  const fits = candidates.find((candidate) => inside(candidate.rect, area))
  return fits?.side ?? 'below'
}

export function createCursorHud(options: CursorHudOptions): CursorHud {
  let win: BrowserWindow | null = null
  let loaded: Promise<void> | null = null
  let visible = false
  /** Where the layer was last put, so an unchanged position is not re-applied. */
  let placed: ScreenRect | null = null
  /** The newest turn state; a window that was still loading paints this one. */
  let state: Shown | null = null
  let exitTimer: NodeJS.Timeout | null = null
  /** Bumped on every paint, so a stale fade-out cannot hide a new turn. */
  let paintToken = 0
  /** The last frame handed to the renderer, for a page that is still loading. */
  let lastFrame: HudFrame | null = null

  function loadPage(target: BrowserWindow): void {
    const devServer = process.env['ELECTRON_RENDERER_URL']
    if (devServer) void target.loadURL(`${devServer}/hud/index.html`)
    else void target.loadFile(join(__dirname, '../renderer/hud/index.html'))
  }

  function createWindow(): BrowserWindow {
    const next = new BrowserWindow({
      width: WIDTH,
      height: HEIGHT,
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
      // Same trick as the drawing layer: not focusable means showing it never
      // activates the app and never pulls the caret out of the user's field.
      focusable: false,
      skipTaskbar: true,
      acceptFirstMouse: false,
      roundedCorners: false,
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        sandbox: false,
        contextIsolation: true,
        nodeIntegration: false
      }
    })

    // The bubble is a picture, not a control: clicks belong to the app underneath.
    next.setIgnoreMouseEvents(true)
    next.setAlwaysOnTop(true, 'screen-saver')
    next.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    // Without this the bubble would be photographed into the very screenshot the
    // model is about to be asked about, and would come back as "there is text on
    // your screen that says Слушаю".
    next.setContentProtection(true)

    next.on('closed', () => {
      win = null
      loaded = null
      visible = false
      placed = null
    })

    next.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
      return { action: 'deny' }
    })

    loadPage(next)
    return next
  }

  /**
   * Resolves once the page can receive messages.
   *
   * Bounded, because a page that never finishes loading (a broken bundle, a dev
   * server mid-restart) would otherwise leave the bubble waiting forever and the
   * user with no feedback at all.
   */
  function ensureWindow(): Promise<BrowserWindow | null> {
    if (win && !win.isDestroyed() && loaded) return loaded.then(() => (win && !win.isDestroyed() ? win : null))
    const created = createWindow()
    win = created
    loaded = new Promise<void>((resolve) => {
      let settled = false
      const done = (): void => {
        if (settled) return
        settled = true
        resolve()
      }
      created.webContents.once('did-finish-load', done)
      created.webContents.once('did-fail-load', done)
      created.webContents.once('destroyed', done)
      setTimeout(done, LOAD_TIMEOUT_MS)
    })
    return loaded.then(() => (win && !win.isDestroyed() ? win : null))
  }

  /** Where the layer and the chip go for the pointer's current spot. */
  function measure(): { bounds: ScreenRect; anchor: { x: number; y: number }; side: HudSide } {
    const cursor = screen.getCursorScreenPoint()
    const area = screen.getDisplayNearestPoint(cursor).workArea
    let avoid: ScreenRect | null = null
    try {
      avoid = options.avoid()
    } catch {
      // A card that closed between the read and the placement must not take the
      // bubble down with it.
      avoid = null
    }
    // The layer is clamped to the display, never the chip: the chip is placed
    // from `anchor`, so clamping moves the pointer off the layer's centre and the
    // renderer still draws the chip in the right spot.
    const x = clamp(cursor.x - WIDTH / 2, area.x, area.x + area.width - WIDTH)
    const y = clamp(cursor.y - HEIGHT / 2, area.y, area.y + area.height - HEIGHT)
    return {
      bounds: { x: Math.round(x), y: Math.round(y), width: WIDTH, height: HEIGHT },
      anchor: { x: Math.round(cursor.x - x), y: Math.round(cursor.y - y) },
      side: pickSide(cursor, area, avoid)
    }
  }

  function send(target: BrowserWindow, shown: Shown, isVisible: boolean): HudFrame {
    const payload: HudFrame = {
      visible: isVisible,
      phase: shown.phase,
      level: isVisible ? shown.level : 0,
      anchor: shown.anchor,
      side: shown.side
    }
    lastFrame = payload
    if (!target.isDestroyed()) target.webContents.send(CH.hud.state, payload)
    return payload
  }

  async function paint(): Promise<void> {
    if (exitTimer) {
      clearTimeout(exitTimer)
      exitTimer = null
    }
    const token = ++paintToken

    const target = await ensureWindow()
    const shown = state
    // `state` may have been cleared by a hide while the window was loading.
    if (!target || !shown || token !== paintToken) return

    const spot = measure()
    const next: Shown = { ...shown, anchor: spot.anchor, side: spot.side }
    state = next

    if (
      !placed ||
      placed.x !== spot.bounds.x ||
      placed.y !== spot.bounds.y ||
      placed.width !== spot.bounds.width ||
      placed.height !== spot.bounds.height
    ) {
      target.setBounds(spot.bounds)
      placed = spot.bounds
    }

    // Show before sending: the renderer starts its entrance animation as the
    // frame arrives, and a window that is not on screen yet would eat its first
    // 100 ms.
    if (!visible) {
      visible = true
      target.showInactive()
    }
    send(target, next, true)
  }

  function hide(): void {
    const target = win
    const shown = state
    state = null
    const token = ++paintToken
    if (exitTimer) {
      clearTimeout(exitTimer)
      exitTimer = null
    }
    if (!target || target.isDestroyed() || !shown) {
      visible = false
      placed = null
      return
    }
    send(target, shown, false)
    exitTimer = setTimeout(() => {
      exitTimer = null
      // A new turn may have started while the fade was running.
      if (token !== paintToken) return
      if (!target.isDestroyed()) target.hide()
      visible = false
      placed = null
    }, EXIT_MS)
  }

  return {
    update(event: VoiceEvent): void {
      if (event.phase === 'idle') {
        // Keep the last painted geometry for the fade, but stop treating it as
        // current: a late `paint` must not resurrect a finished turn.
        hide()
        return
      }
      state = {
        phase: event.phase === 'transcribing' ? 'transcribing' : 'listening',
        level: event.phase === 'listening' ? clamp01(event.level) : 0,
        anchor: state?.anchor ?? { x: Math.round(WIDTH / 2), y: Math.round(HEIGHT / 2) },
        side: state?.side ?? 'below'
      }
      void paint()
    },

    prewarm(): void {
      void ensureWindow()
    },

    getState(): HudFrame | null {
      return lastFrame
    },

    destroy(): void {
      if (exitTimer) {
        clearTimeout(exitTimer)
        exitTimer = null
      }
      visible = false
      placed = null
      state = null
      lastFrame = null
      if (win && !win.isDestroyed()) win.destroy()
      win = null
      loaded = null
    }
  }
}
