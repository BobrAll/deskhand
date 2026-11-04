/**
 * Window management: the overlay (placed at the cursor) plus the standalone
 * settings and onboarding windows. Each renderer is its own Vite entry, so each
 * window loads its own page.
 */

import { join } from 'node:path'
import { app, BrowserWindow, screen, shell } from 'electron'
import type { OverlayHost } from './overlay'

/**
 * The overlay is a small bubble next to the cursor, not a window: it appears as a
 * one-line field, and grows downwards (or upwards, when the pointer is near the
 * bottom of the display) only as an answer is streamed into it.
 */
/**
 * Width of the bubble once there is something to read (an answer, the unfolded
 * context strip). Folded — which is how it opens — it is `OVERLAY_NARROW_WIDTH`,
 * a small pill about three times as wide as the single line it is tall; it widens
 * to `OVERLAY_WIDTH` only when content actually needs the room.
 */
export const OVERLAY_WIDTH = 360
export const OVERLAY_NARROW_WIDTH = 112
/**
 * The floor for the width. A voice turn shows nothing but a few bars, and the
 * window shrinks to fit them so the animation sits right next to the pointer
 * instead of in the middle of an invisible 112 pt strip.
 */
const OVERLAY_MIN_WIDTH = 44

/**
 * Width of the voice surface — the bars, and nothing else.
 *
 * 80 is not a design number, it is a macOS floor: a *transparent* window smaller
 * than 80 points on both sides is composited as an opaque white rectangle, no
 * matter what `transparent`, `backgroundColor`, `hasShadow` or `vibrancy` say. The
 * bars only need 44, but at 44×33 the window showed up as a white card behind
 * them — that was the "фон" that could not be styled away from CSS, because it was
 * never the page: it was the window. With one side at 80 the window is genuinely
 * transparent and the extra space is invisible.
 *
 * The other half of that "фон" is the native window shadow, which `applyWindowChrome`
 * removes for the duration of the turn: AppKit draws it around the window's
 * rectangle, so an otherwise empty voice window still cast a soft grey card over
 * the document behind it.
 */
export const OVERLAY_VOICE_WIDTH = 80
/**
 * The window is exactly as tall as the folded bubble: one 17px text line plus
 * 6px of padding and the 1px edge on each side (31px). Anything taller leaves a
 * strip of bare vibrancy under the card, which reads as the panel being bigger —
 * and more transparent — than it is.
 */
export const OVERLAY_MIN_HEIGHT = 31
export const OVERLAY_MAX_HEIGHT = 520

/** Clearance between the pointer and the bubble, in points. */
const GAP = 10
/** How close the bubble may get to a display edge. */
const MARGIN = 8

const preload = join(__dirname, '../preload/index.js')

function load(win: BrowserWindow, page: string): void {
  const devServer = process.env['ELECTRON_RENDERER_URL']
  if (devServer) void win.loadURL(`${devServer}/${page}/index.html`)
  else void win.loadFile(join(__dirname, `../renderer/${page}/index.html`))
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

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
    width: OVERLAY_NARROW_WIDTH,
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
    // so both the shadow and the blur below describe the rounded bubble and not
    // a rectangle around it. An earlier version had an 8px transparent margin
    // for a CSS shadow, and macOS drew its shadow around that whole rectangle —
    // which is what read as a second, translucent pane under the bubble.
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
    // The window is gone and nothing is painted or spoken through it any more.
    // Keeping `voice`/`drawing` would make the *next* creation bare before any
    // turn asked for it; the next session starts from the resting card state.
    drawing = false
    voice = false
  })

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

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
  load(win, 'overlay')
  return win
}
/**
 * Where the bubble hangs off the pointer.
 *
 * Kept for the lifetime of one showing: the answer streams in and the bubble
 * grows, and a rectangle re-placed from scratch on every height change would
 * drift away from the cursor (and, worse, hop above it mid-answer). The pointer
 * position, the side it was placed on and the horizontal edge are therefore
 * remembered once and only the vertical edge is recomputed.
 */
interface BubbleAnchor {
  /** The pointer at the moment the bubble appeared, in global screen points. */
  point: { x: number; y: number }
  area: Electron.Rectangle
  /** Left edge of the bubble; it may sit left of the pointer when flipped. */
  x: number
  /** `true` when the bubble hangs above the pointer instead of below it. */
  above: boolean
  /**
   * The side of the pointer the bubble hangs on.
   *
   * Remembered because the bubble now *grows sideways*: it opens as a 112 pt pill
   * and widens with every letter typed, so the horizontal edge has to be computed
   * from the width each time instead of being frozen at the size it opened with.
   * The side is the part that stays.
   */
  right: boolean
}

let anchor: BubbleAnchor | null = null

/** Remaining room on either side of the pointer, inside the current work area. */
function roomAround(point: { x: number; y: number }, area: Electron.Rectangle) {
  return {
    below: area.y + area.height - MARGIN - (point.y + GAP),
    above: point.y - GAP - (area.y + MARGIN)
  }
}

/**
 * Records the anchor for a bubble of the given height (ТЗ §8: next to the cursor).
 *
 * Placed down-and-right of the pointer, flipped left near the right edge and
 * above near the bottom edge — the shortest path to "it appeared where I was
 * looking", with the pointer never covered.
 */
function placeAnchor(height: number, width: number): BubbleAnchor {
  const point = screen.getCursorScreenPoint()
  const area = screen.getDisplayNearestPoint(point).workArea
  const right = point.x + GAP + width <= area.x + area.width - MARGIN

  const room = roomAround(point, area)
  const placed: BubbleAnchor = {
    point,
    area,
    x: 0,
    above: height > room.below && height <= room.above,
    right
  }
  placed.x = xFor(placed, width)
  return placed
}

/**
 * The horizontal edge for a given width.
 *
 * The side chosen at placement is kept: a card that hopped over the pointer
 * because one more letter no longer fitted would move out from under the eyes
 * reading it, which is worse than the card growing into the pointer's own column.
 * Growing therefore pushes the *far* edge away, and near a display edge the far
 * edge is what gets pinned — the card slides just enough to stay on screen.
 */
function xFor(placed: BubbleAnchor, width: number): number {
  const min = placed.area.x + MARGIN
  const max = Math.max(min, placed.area.x + placed.area.width - width - MARGIN)
  const wanted = placed.right ? placed.point.x + GAP : placed.point.x - width - GAP
  return clamp(wanted, min, max)
}

/** The vertical edge for a given height, clamped so the bubble stays on screen. */
function yFor(placed: BubbleAnchor, height: number): number {
  const raw = placed.above ? placed.point.y - GAP - height : placed.point.y + GAP
  const max = placed.area.y + placed.area.height - height - MARGIN
  return clamp(raw, placed.area.y + MARGIN, Math.max(placed.area.y + MARGIN, max))
}

function positionOverlay(win: BrowserWindow, height: number, width: number): void {
  anchor = placeAnchor(height, width)
  win.setBounds({
    x: Math.round(anchor.x),
    y: Math.round(yFor(anchor, height)),
    width: Math.round(width),
    height: Math.round(height)
  })
}

/**
 * Re-applies the remembered anchor to a new size.
 *
 * Both edges are re-derived, because both dimensions change while a turn runs:
 * the card widens with every letter typed and grows downwards as the answer
 * arrives. What stays is the *anchor* — the pointer it was placed against and the
 * sides it was placed on — so the card grows away from the pointer instead of
 * crawling out from under it.
 *
 * A bubble the user dragged away is left where they put it and grows from there:
 * yanking it back to the old pointer position mid-answer would move the text out
 * from under the eyes that are reading it.
 */
function resizeAtAnchor(win: BrowserWindow, height: number, width: number): void {
  if (!anchor) {
    positionOverlay(win, height, width)
    return
  }
  const placed = anchor
  const bounds = win.getBounds()
  // The pointer may have been on another display when the bubble opened; the
  // work area of *that* display is what the bubble has to stay inside.
  placed.area = screen.getDisplayNearestPoint(placed.point).workArea

  const dragged =
    Math.abs(bounds.x - placed.x) > 2 || Math.abs(bounds.y - yFor(placed, bounds.height)) > 2

  if (dragged) {
    placed.area = screen.getDisplayNearestPoint({ x: bounds.x, y: bounds.y }).workArea
    // Re-derive the pointer from the current top edge, so the height change keeps
    // the edge the user chose instead of the one it was placed with. The
    // horizontal edge stays where the card was dropped — it is the user's choice —
    // and is only pulled back when growing wider would carry it off the display.
    const min = placed.area.x + MARGIN
    const max = Math.max(
      min,
      placed.area.x + placed.area.width - width - MARGIN
    )
    placed.x = clamp(bounds.x, min, max)
    placed.point = {
      x: placed.point.x,
      y: placed.above ? bounds.y + bounds.height + GAP : bounds.y - GAP
    }
  } else {
    const room = roomAround(placed.point, placed.area)
    if (height > room.below && height <= room.above) placed.above = true
    else if (height > room.above && height <= room.below) placed.above = false
    // The width changed with the text, so the horizontal edge is re-derived too:
    // the card widens away from the pointer instead of running off the display.
    placed.x = xFor(placed, width)
  }

  win.setBounds({
    x: Math.round(placed.x),
    y: Math.round(yFor(placed, height)),
    width: Math.round(width),
    height
  })
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
  /**
   * A card that is already on screen keeps its own size.
   *
   * Both numbers passed here are guesses: the folded card is 31 points tall until
   * the renderer lays itself out, and 112 wide until the user types something. The
   * renderer reports the real size a frame later and resizes the window itself, so
   * re-applying a guess over a card that is already being typed into would shrink
   * it back to the empty pill between two keystrokes. Placement is still re-run —
   * a second press should bring the card to wherever the pointer is now.
   */
  const current = overlayVisible ? win.getBounds() : null
  positionOverlay(win, current?.height ?? height, current?.width ?? width)
  // Already on screen (a second press while the card is open): only the focus
  // question is left, and re-showing a visible window makes macOS re-run its
  // order-front animation for no reason.
  if (!overlayVisible) {
    overlayVisible = true
    if (activate) win.show()
    else win.showInactive()
  }
  if (!activate) return
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
 * Shows the bubble at the given size, optionally without taking focus.
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
  // it. The renderer asks for `OVERLAY_VOICE_WIDTH` throughout the turn; this is
  // the same number applied at the moment the window is actually shown.
  const safeWidth = Math.round(
    clamp(voice ? OVERLAY_VOICE_WIDTH : width, OVERLAY_MIN_WIDTH, OVERLAY_WIDTH)
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

  show(height: number, width = OVERLAY_NARROW_WIDTH): void {
    presentOverlay(height, width, true)
  },

  showInactive(height: number, width = OVERLAY_NARROW_WIDTH): void {
    presentOverlay(height, width, false)
  },

  resize(height: number, width = OVERLAY_WIDTH): void {
    const win = overlayWindow
    if (!win || win.isDestroyed()) return
    const safeHeight = Math.round(clamp(height, OVERLAY_MIN_HEIGHT, OVERLAY_MAX_HEIGHT))
    const safeWidth = Math.round(clamp(width, OVERLAY_MIN_WIDTH, OVERLAY_WIDTH))
    const bounds = win.getBounds()
    if (bounds.height === safeHeight && bounds.width === safeWidth) return
    resizeAtAnchor(win, safeHeight, safeWidth)
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
    if (voice === active) return
    voice = active
    applyWindowChrome()
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
    // moved since this bubble appeared.
    anchor = null
    if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.hide()
  },

  window(): BrowserWindow | null {
    return overlayWindow && !overlayWindow.isDestroyed() ? overlayWindow : null
  }
}

/**
 * Whether the card is currently transparent to input (an agent plan is running).
 * Tracked so `setIgnoreMouseEvents` is not called on every frame — it is cheap,
 * but toggling it re-enters the window server and can drop a click that was
 * already in flight.
 */
let passthrough = false

let settingsWindow: BrowserWindow | null = null
let onboardingWindow: BrowserWindow | null = null

function baseOptions(
  title: string,
  width: number,
  height: number
): Electron.BrowserWindowConstructorOptions {
  return {
    width,
    height,
    show: false,
    title,
    backgroundColor: '#0f1115',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 18 },
    webPreferences: {
      preload,
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  }
}

export function openSettingsWindow(): BrowserWindow {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.show()
    settingsWindow.focus()
    return settingsWindow
  }

  const win = new BrowserWindow({
    ...baseOptions('Smart Cursor — настройки', 980, 760),
    minWidth: 820,
    minHeight: 560
  })
  settingsWindow = win
  win.once('ready-to-show', () => {
    win.show()
    try {
      app.focus({ steal: true })
    } catch {
      /* ignore */
    }
  })
  /**
   * ⌘W and the red traffic light both come through here, not through
   * `settings:close`, so the grace period for an in-flight write has to live on
   * the window as well — otherwise the one gesture everybody uses to close a
   * window would be the one that loses the last keystroke.
   */
  let closing = false
  win.on('close', (event) => {
    if (closing || !settingsBusy) return
    event.preventDefault()
    closing = true
    // Polled rather than a fixed wait: a write usually lands in a few
    // milliseconds, and making the user watch a 1.2 s pause for it would be its
    // own small bug. The ceiling only exists so a wedged renderer cannot make the
    // window unclosable.
    const deadline = Date.now() + 1200
    const attempt = (): void => {
      if (win.isDestroyed()) return
      if (!settingsBusy || Date.now() >= deadline) {
        win.close()
        return
      }
      setTimeout(attempt, 80)
    }
    setTimeout(attempt, 80)
  })
  win.on('closed', () => {
    settingsWindow = null
    settingsBusy = false
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  load(win, 'settings')
  return win
}

export function openOnboardingWindow(): BrowserWindow {
  if (onboardingWindow && !onboardingWindow.isDestroyed()) {
    onboardingWindow.show()
    onboardingWindow.focus()
    return onboardingWindow
  }

  const win = new BrowserWindow({ ...baseOptions('Smart Cursor', 760, 660), resizable: false })
  onboardingWindow = win
  win.once('ready-to-show', () => {
    win.show()
    try {
      app.focus({ steal: true })
    } catch {
      /* ignore */
    }
  })
  win.on('closed', () => {
    onboardingWindow = null
  })
  load(win, 'onboarding')
  return win
}

export function closeOnboardingWindow(): void {
  if (onboardingWindow && !onboardingWindow.isDestroyed()) onboardingWindow.close()
}

export function closeSettingsWindow(): void {
  if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.close()
}

/**
 * Closes the settings window, letting any in-flight write land first.
 *
 * The waiting itself lives on the window's `close` handler, so every route to
 * closing — the «Закрыть» button, ⌘W, the red traffic light — goes through the
 * same grace period instead of only the one that happens to call this.
 */
export function closeSettingsWindowWhenSettled(): void {
  closeSettingsWindow()
}

/** Set by `settings:hold` while the renderer still has edits to write. */
export function markSettingsBusy(busy: boolean): void {
  settingsBusy = busy
}

let settingsBusy = false

/**
 * Brings the most relevant open window back to the foreground after the app is
 * re-activated. With the tray-only (accessory) activation policy macOS can leave
 * windows hidden behind other apps, so the user "loses" them after Alt+Tab; this
 * makes sure an already-open window is shown again rather than silently missing.
 */
export function showActiveWindow(): void {
  const candidates = [overlayWindow, settingsWindow, onboardingWindow]
  for (const win of candidates) {
    if (win && !win.isDestroyed() && win.isVisible()) {
      win.show()
      win.focus()
      return
    }
  }
}