/**
 * Window management: the overlay (placed at the cursor) plus the standalone
 * settings and onboarding windows. Each renderer is its own Vite entry, so each
 * window loads its own page.
 */

import { join } from 'node:path'
import { app, BrowserWindow, screen } from 'electron'
import {
  CARD_MAX_WIDTH,
  CARD_MIN_WIDTH,
  CARD_NARROW_WIDTH,
  CARD_VOICE_WIDTH,
  CARD_WIDTH
} from '@shared/metrics'
import type { OverlayHost } from '../overlay/host'
import {
  boundsFor,
  placeAnchor,
  resizeAnchor,
  type CardAnchor
} from '../card'
import { clamp } from '../util'
import { denyExternalLinks } from '../denyExternalLinks'
import { loadPage } from '../pageLoad'
import { settingsWindows } from './settings'

export {
  openSettingsWindow,
  openOnboardingWindow,
  closeOnboardingWindow,
  closeSettingsWindow,
  setSettingsHeld
} from './settings'

/**
 * The overlay is a small card next to the cursor, not a window: it appears as a
 * one-line field, and grows downwards (or upwards, when the pointer is near the
 * bottom of the display) only as an answer is streamed into it.
 *
 * Its widths live in `@shared/metrics` because the renderer needs the very same
 * numbers to decide where a line wraps and how wide a card to ask for. Height and
 * the placement gap are main's business only, so they stay here.
 */
const OVERLAY_MIN_HEIGHT = 31
const OVERLAY_MAX_HEIGHT = 520

const preload = join(__dirname, '../preload/index.js')

let overlayWindow: BrowserWindow | null = null
let overlayVisible = false
/**
 * Whether the page has painted at least once.
 *
 * A prewarmed window is loaded long before the first press, but a window created
 * by the press itself (the very first one after launch, before `prewarm` ran) has
 * nothing on screen yet, and showing it then flashes a white rectangle where the
 * card will be. Tracked separately from `overlayVisible` because the two answer
 * different questions: "is it on screen" and "is there anything to see".
 */
let overlayReady = false
/** Whether the card is currently in its thin, see-through "drawing" state. */
let drawing = false
/** True while a voice turn shows bare bars instead of the card. */
let voice = false
/**
 * Whether the card is currently transparent to input (an agent plan is running).
 * Tracked so `setIgnoreMouseEvents` is not called on every frame — it is cheap,
 * but toggling it re-enters the window server and can drop a click that was
 * already in flight.
 */
let passthrough = false

/**
 * One place decides what the *window* contributes to the picture.
 *
 * A voice turn is the strict case: the page draws a few pixels of bars and
 * nothing else, so the window must add nothing at all. Both bits of native chrome
 * are therefore removed while `voice` is on:
 *
 * - vibrancy — a blurred rectangle behind what is meant to be bare bars;
 * - the native window shadow — AppKit draws it around the window's *rectangle*,
 *   not around what the page painted, so an empty 80×31 window still casts a soft
 *   rounded-rectangle shadow over the document behind it. On a white page that
 *   grey halo is exactly what reads as "a card I never asked for".
 *
 * The drawing state only needs the blur gone (the card is still there, thin, and
 * its shadow helps it read as a pane of glass). Guarded by the flags because both
 * calls rebuild native views, and doing that on every redraw flickers.
 */
function applyWindowChrome(): void {
  const win = overlayWindow
  if (!win || win.isDestroyed()) return
  win.setVibrancy(drawing || voice ? null : 'under-window')
  win.setHasShadow(!voice)
}

function createOverlayWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: CARD_NARROW_WIDTH,
    height: OVERLAY_MIN_HEIGHT,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    movable: true,
    minimizable: true,
    maximizable: false,
    fullscreenable: false,
    acceptFirstMouse: true,
    roundedCorners: true,
    // The window is exactly the card (the renderer keeps no transparent margin),
    // so both the shadow and the blur below describe the rounded card and not
    // a rectangle around it. An earlier version had an 8px transparent margin
    // for a CSS shadow, and macOS drew its shadow around that whole rectangle —
    // which is what read as a second, translucent pane under the card.
    //
    // These two follow the flags rather than a hardcoded "card": a window can be
    // *created* by the first voice press (when the feature was just switched on
    // and the prewarm has not run), and a fresh window with glass and a shadow
    // would put a panel behind the bars for the whole turn.
    hasShadow: !voice,
    // Real frosting: `backdrop-filter` in a transparent window only has the
    // page's own (empty) backdrop to sample, so the glass would just show the
    // app behind it unblurred. The vibrancy view blurs the desktop instead.
    vibrancy: drawing || voice ? undefined : 'under-window',
    visualEffectState: 'active',
    webPreferences: {
      preload,
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: true
    }
  })

  // The card is an ordinary window, not a floating HUD: it takes focus while the
  // user types into it and it goes behind another app's window like any other
  // window would. Agent mode is the one exception — a plan presses things in the
  // app in front of the card, so the step-by-step has to stay readable there.
  // `setPassthrough` is the single place that decides that: it raises the card
  // when a plan runs and lowers it again the moment the run is over.

  // The overlay is the window that records push-to-talk, so it is the only one
  // that may ask for the microphone. Everything else is refused outright.
  win.webContents.session.setPermissionRequestHandler((_contents, permission, callback) => {
    callback(permission === 'media')
  })
  win.webContents.session.setPermissionCheckHandler(
    (_contents, permission) => permission === 'media'
  )

  win.on('closed', () => {
    overlayWindow = null
    overlayReady = false
    overlayVisible = false
    // The window is gone and nothing is painted or spoken through it any more.
    // Keeping `voice`/`drawing` would make the *next* creation bare before any
    // turn asked for it; the next session starts from the resting card state.
    drawing = false
    voice = false
  })

  denyExternalLinks(win)

  // The flags are not reset here: if this window was forced into existence by a
  // live voice turn, that turn is still running and its bars have to stay bare.
  // The `closed` handler is where they go back to the resting card state.
  //
  // `ready-to-show` is what makes the first press honest: a prewarmed window is
  // loaded ahead of time, but one created *by* the press has nothing on screen
  // yet, and showing it then flashes a white rectangle where the card will be. A
  // show requested before this point is remembered in `pendingShow` and honoured
  // here, so the press is never dropped — only deferred by the paint.
  win.once('ready-to-show', () => {
    overlayReady = true
    const pending = pendingShow
    pendingShow = null
    if (pending) performShow(pending.height, pending.width, pending.activate)
  })
  win.on('will-move', () => { resizeBounds = null })
  loadPage(win, 'overlay')
  return win
}

/** The anchor of the card currently on screen, if any. */
let anchor: CardAnchor | null = null
// Native animation may still be between frames when the next letter arrives.
// Placement must use the last destination, not mistake that frame for a drag.
let resizeBounds: Electron.Rectangle | null = null

/** The work area of the display a point falls on. */
function workAreaAt(point: { x: number; y: number }): Electron.Rectangle {
  return screen.getDisplayNearestPoint(point).workArea
}

function positionOverlay(win: BrowserWindow, height: number, width: number): void {
  const point = screen.getCursorScreenPoint()
  anchor = placeAnchor(point, workAreaAt(point), height, width)
  resizeBounds = boundsFor(anchor, height, width)
  win.setBounds(resizeBounds)
}

/**
 * Re-applies the remembered anchor to a new size, or places the card for the
 * first time when there is no anchor yet.
 */
function resizeAtAnchor(win: BrowserWindow, height: number, width: number, pin = false): void {
  if (!anchor) {
    positionOverlay(win, height, width)
    return
  }
  anchor = resizeAnchor({
    anchor,
    bounds: resizeBounds ?? win.getBounds(),
    height,
    width,
    workAreaAt,
    pin
  })
  resizeBounds = boundsFor(anchor, height, width)
  // Native animation is right for a card that grows as text arrives — one small
  // step, eased. It is wrong for a drag: macOS animates every `setBounds` over
  // its own duration, so a hundred frames a second each get their own easing and
  // the window lags behind the hand in a soft rubber band. A dragged edge has to
  // land exactly where the pointer is, this frame.
  win.setBounds(resizeBounds, !pin && !voice && overlayVisible)
}

/**
 * The show request waiting for the first paint, if any.
 *
 * Only one can be pending: the card is shown for one turn at a time, and a second
 * press during the wait is the same request with a newer size — keeping the last
 * one is what makes the later press win instead of the earlier one.
 */
let pendingShow: { height: number; width: number; activate: boolean } | null = null

function performShow(height: number, width: number, activate: boolean): void {
  const win = overlayWindow
  if (!win || win.isDestroyed()) return
  // A card that is already on screen keeps its own size.
  //
  // Both numbers passed here are guesses: the folded card is 31 points tall until
  // the renderer lays itself out, and 112 wide until the user types something. The
  // renderer reports the real size a frame later and resizes the window itself, so
  // re-applying a guess over a card that is already being typed into would shrink
  // it back to the empty pill between two keystrokes. Keep the position when the
  // visible card takes focus after context collection.
  const current = overlayVisible ? win.getBounds() : null
  const focusExisting = activate && current && win.isVisible()
  if (!focusExisting) {
    positionOverlay(win, current?.height ?? height, current?.width ?? width)
  }
  // An inactive show is also used to reveal voice bars and a completed answer.
  // A logically visible window may be behind another app, or the app itself may
  // have been hidden while returning focus. Raise it without taking the keyboard.
  if (!activate) {
    if (app.isHidden()) app.show()
    overlayVisible = true
    win.showInactive()
    return
  }
  // Already on screen (a second press while the card is open): only the focus
  // question is left, and re-showing a visible window makes macOS re-run its
  // order-front animation for no reason.
  if (!overlayVisible || !win.isVisible()) {
    overlayVisible = true
    win.show()
  }
  // The card is not a HUD. Shown as an ordinary focused window it is already in
  // front of the app it is about, and it goes behind another app's window the way
  // any window does — that is the behaviour the panel had before it started
  // hanging over everything. The one exception is a running agent plan, and that
  // exception is decided in `setPassthrough`, not here: the plan presses things in
  // a window that would otherwise cover the card. `passthrough` is read instead
  // of assumed so a show arriving mid-plan cannot drop the card behind the app
  // the plan is working in.
  win.setAlwaysOnTop(passthrough, 'floating')
  win.focus()
  try {
    app.focus({ steal: true })
  } catch {
    /* keeping the current focus is acceptable */
  }
}

/**
 * Shows the card at the given size, optionally without taking focus.
 *
 * The inactive path exists for push-to-talk. The bars have to be on screen
 * immediately, but `collectContext` still has to read the app the user is
 * speaking *about*: activating our own window first would make the frontmost app
 * the assistant itself, and the selection would come back empty (or, worse, our
 * own card). The voice preview therefore shows without focus, and the real card
 * is focused only after the context has been collected.
 *
 * The keyboard path uses the same inactive show for the same reason, and both
 * paths go through `pendingShow` when the page has not painted yet — see
 * `overlayReady`.
 */
function presentOverlay(height: number, width: number, activate: boolean): void {
  const safeHeight = Math.round(clamp(height, OVERLAY_MIN_HEIGHT, OVERLAY_MAX_HEIGHT))
  // A voice turn is bars only, and the caller's width describes a card that is
  // not there: the overlay shows itself mid-turn at `INITIAL_HEIGHT` with its
  // default narrow width, which would leave the invisible window 32 points wider
  // than the few pixels it paints. That extra strip is invisible but still
  // belongs to the window, so it sits between the pointer and whatever is under
  // it. The renderer asks for `CARD_VOICE_WIDTH` throughout the turn; this is
  // the same number applied at the moment the window is actually shown.
  const safeWidth = Math.round(
    clamp(voice ? CARD_VOICE_WIDTH : width, CARD_MIN_WIDTH, CARD_WIDTH)
  )

  if (!overlayWindow) {
    // The window is created here and the show is remembered: the first paint can
    // be a frame away, and showing before it flashes a white rectangle.
    overlayWindow = createOverlayWindow()
    pendingShow = { height: safeHeight, width: safeWidth, activate }
    return
  }

  // A window that has not painted yet would show a white rectangle for a frame —
  // and it is precisely the first press after launch, when the renderer is still
  // loading, that would flash. The request is remembered instead of dropped, so
  // the card is still shown the moment there is something to show.
  if (!overlayReady) {
    pendingShow = { height: safeHeight, width: safeWidth, activate }
    return
  }

  performShow(safeHeight, safeWidth, activate)
}

export const overlayHost: OverlayHost = {
  /**
   * Creates the overlay window without showing it.
   *
   * Both entry points need the *renderer* alive before the first key press.
   * Push-to-talk needs the microphone, which lives there. The keyboard path needs
   * the page itself: the card is put on screen before the context is collected, so
   * a window created on the press would spend that delay loading a page instead of
   * showing anything — and until the first paint lands there is nothing to show but
   * a white rectangle. A warmed window makes the delay a message round-trip.
   */
  prewarm(): void {
    if (overlayWindow && !overlayWindow.isDestroyed()) return
    overlayWindow = createOverlayWindow()
  },

  show(height: number, width = CARD_NARROW_WIDTH): void {
    presentOverlay(height, width, true)
  },

  showInactive(height: number, width = CARD_NARROW_WIDTH): void {
    presentOverlay(height, width, false)
  },

  resize(height: number, width = CARD_WIDTH, pin = false): void {
    const win = overlayWindow
    if (!win || win.isDestroyed()) return
    const safeHeight = Math.round(clamp(height, OVERLAY_MIN_HEIGHT, OVERLAY_MAX_HEIGHT))
    // The user's own width may exceed what content is allowed to ask for: a
    // dragged card is a person's decision, and clamping it back to the content
    // cap would make the drag spring back under the hand.
    const safeWidth = Math.round(clamp(width, CARD_MIN_WIDTH, CARD_MAX_WIDTH))
    const bounds = resizeBounds ?? win.getBounds()
    if (bounds.height === safeHeight && bounds.width === safeWidth && !pin) return
    resizeAtAnchor(win, safeHeight, safeWidth, pin)
  },

  /**
   * Swaps the card between frosted glass and plain tinted glass.
   *
   * While the assistant is drawing, the card is deliberately thin (the renderer
   * drops to 40% opacity) so that the screen it is pointing at shows through. The
   * vibrancy view would undo that: it blurs the desktop behind the window, so the
   * "see-through" state would show a smeared copy of the annotated region instead
   * of the region itself. Removing it while shapes are up is what makes the
   * transparency actually reveal the target.
   *
   * Guarded by `drawing` because `setVibrancy` rebuilds a native view: calling it
   * on every redraw would flicker the card.
   */
  setDrawing(active: boolean): void {
    if (drawing === active) return
    drawing = active
    applyWindowChrome()
  },

  /**
   * The strictest state: the card has no surface at all, the bars are the entire
   * thing. Both the native blur *and* the window shadow have to go, or the bars
   * sit on a soft grey rectangle over the user's document — see
   * `applyWindowChrome`. The bar animation itself is unchanged.
   */
  setVoice(active: boolean): void {
    if (voice !== active) {
      voice = active
      applyWindowChrome()
    }
  },

  /**
   * Lets clicks and keys pass through the card while an agent plan runs.
   *
   * This is the one place where "the assistant is driving" changes the window
   * itself. The card normally takes focus and swallows the mouse, which is right
   * for a panel you type in and fatal for a plan: the first synthetic click would
   * land on the card, not on the app the plan is about. Passing through makes the
   * window transparent to input while still painting, so the card can keep
   * reporting progress *and* stay out of the way.
   *
   * `forward: true` is kept so the renderer still receives hover/move events and
   * the card does not go visually dead while it is being ignored.
   */
  setPassthrough(active: boolean): void {
    const win = overlayWindow
    if (!win || win.isDestroyed()) return
    if (passthrough === active) return
    passthrough = active
    win.setIgnoreMouseEvents(active, { forward: true })
    // The floating level belongs to the run and to nothing else. While a plan
    // presses things in another app, the card reports its steps over a window it
    // would otherwise sit behind — so it is raised for exactly as long as the
    // plan is alive. Once the run ends (`active === false`) the card goes back to
    // the ordinary level: from then on the answer is what the user is reading,
    // and a panel pinned above every window after the assistant stopped working
    // is just a window in the way.
    win.setAlwaysOnTop(active, 'floating')
    if (active) {
      // Focus must leave the card too: a focused window still owns the keyboard,
      // so `@type` would type into our own input field.
      try {
        win.blur()
      } catch {
        /* blurring is best effort */
      }
    }
  },

  hide(): void {
    // A hidden card must never stay click-through: the next session opens with a
    // panel that expects the mouse.
    if (passthrough) {
      passthrough = false
      const win = overlayWindow
      if (win && !win.isDestroyed()) win.setIgnoreMouseEvents(false)
    }
    // The floating level goes with the card: a hidden window that was left pinned
    // would meet the user above every window on the next press. Outside the
    // `passthrough` branch on purpose — a plan can be stopped in a path that never
    // clears the flag (a card closed mid-run), and the level must not survive that.
    {
      const win = overlayWindow
      if (win && !win.isDestroyed()) win.setAlwaysOnTop(false)
    }
    overlayVisible = false
    // A show still waiting for the first paint belongs to the turn that just
    // ended: letting it through would put the card back on screen after it was
    // closed (Escape during the context collection is exactly that case).
    pendingShow = null
    // The next press asks for a fresh anchor: the pointer has almost certainly
    // moved since this card appeared.
    anchor = null
    resizeBounds = null
    if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.hide()
  },

  window(): BrowserWindow | null {
    return overlayWindow && !overlayWindow.isDestroyed() ? overlayWindow : null
  }
}

/**
 * Brings the most relevant open window back to the foreground after the app is
 * re-activated. macOS can leave a window behind other apps — a card shown without
 * focus, a settings window covered by the app it was opened from — so the user
 * "loses" it after Alt+Tab; this makes sure an already-open window is shown again
 * rather than silently missing.
 */
export function showActiveWindow(): void {
  const candidates = [overlayWindow, ...settingsWindows()]
  for (const win of candidates) {
    if (win && !win.isDestroyed() && win.isVisible()) {
      win.show()
      win.focus()
      return
    }
  }
}
