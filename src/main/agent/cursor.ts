/**
 * The cursor highlight: a ring and a one-line caption that follow the pointer
 * while an agent plan runs.
 *
 * Why this exists. The runner moves the *real* cursor with `CGWarpMouseCursorPosition`,
 * so between two steps the pointer teleports across the screen in one frame and a
 * click happens 90 ms later. Without a mark on the pointer, the user sees their
 * cursor jump and a menu open by itself and has no way to tell which step of the
 * plan that was — the card may even be behind the window the assistant is
 * operating. The ring answers "where", the caption answers "what".
 *
 * The three properties from `pointer.ts` apply unchanged: it must
 * never take focus (`focusable: false` + `showInactive`), never eat clicks
 * (`setIgnoreMouseEvents`), and never end up in the next screenshot
 * (`setContentProtection`). A highlight that was photographed would come back to
 * the model as "there is a ring on your screen" and, worse, as a target.
 *
 * Geometry. This layer is display-sized: the ring is moved with a CSS
 * `translate` on every follow tick instead of by moving the window. macOS composites a window move on the main thread and a pointer that
 * the helper warps across the screen would make that visibly late; moving one
 * element inside a stationary layer stays on the compositor and is exact.
 */

import { BrowserWindow, screen } from 'electron'
import { CH } from '@shared/ipc'
import type { AgentCursorFrame, AgentEvent, ScreenRect } from '@shared/types'
import { createLayerWindow } from '../layerWindow'

/** How long the renderer's fade-out runs before the window is actually hidden. */
const EXIT_MS = 160

/** How long to wait for the page before painting anyway. */
const LOAD_TIMEOUT_MS = 1500

/**
 * Follow rate. 16 ms is roughly one display frame: the helper warps the pointer
 * in one jump, so anything slower would show the ring arriving after the click.
 */
const FOLLOW_MS = 16

/** Clearance above the pointer for the caption, in points. Kept in step with CSS. */
const CAPTION_GAP = 26

/**
 * The caption needs this much room above the pointer: the gap, plus the tallest
 * the one-line caption can get. Below it the caption is flipped under the
 * pointer instead of being clamped into the menu bar.
 */
const CAPTION_ROOM = CAPTION_GAP + 38

let win: BrowserWindow | null = null
let loaded: Promise<void> | null = null
let visible = false
/** Where the layer was last put, so an unchanged display is not re-applied. */
let placedOn: ScreenRect | null = null
/** The frame currently being painted; `null` while hidden. */
let frame: AgentCursorFrame | null = null
let follow: NodeJS.Timeout | null = null
let hideTimer: NodeJS.Timeout | null = null
/** Bumped on every paint, so a stale fade-out cannot hide a new step. */
let paintToken = 0
/** Incremented per action, so the renderer replays the click ripple. */
let pulse = 0
/**
 * The turn that currently owns the ring, if any.
 *
 * A turn is not one plan: the model may look at the screen again and continue,
 * and every plan ends with `done`. Hiding on that `done` made the ring go out
 * between two plans and come back a moment later — the user saw the mark blink
 * mid-run and could not tell a pause from the end. While a turn holds the ring,
 * a finished plan parks it in `waiting` instead of hiding it, and only
 * `endAgentTurn` takes it away.
 *
 * The token, not a flag, is what keeps a slow turn from being un-held by an
 * older one: the previous request can finish after the next one has already
 * started, and its release must not take the new turn's ring down.
 */
let held: number | null = null
let turn = 0
/** Stage a `done` into `waiting` after a beat; cancelled by the next step. */
let waitTimer: NodeJS.Timeout | null = null

function createWindow(): BrowserWindow {
  return createLayerWindow({
    page: 'cursor',
    acceptFirstMouse: false,
    caseless: true,
    onClosed: () => {
      win = null
      loaded = null
      visible = false
      placedOn = null
      frame = null
    }
  })
}

/**
 * Resolves once the page can receive messages.
 *
 * Bounded for the same reason as the other layers: a page that never loads would
 * otherwise leave the follow loop waiting forever, and the ring would never
 * appear again in this session.
 */
function ensureWindow(): Promise<BrowserWindow | null> {
  if (win && !win.isDestroyed() && loaded) {
    return loaded.then(() => (win && !win.isDestroyed() ? win : null))
  }
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

function sameRect(a: ScreenRect | null, b: ScreenRect): boolean {
  if (!a) return false
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
}

function displayBounds(): { bounds: ScreenRect; cursor: { x: number; y: number } } {
  const cursor = screen.getCursorScreenPoint()
  const area = screen.getDisplayNearestPoint(cursor).bounds
  return {
    bounds: {
      x: Math.round(area.x),
      y: Math.round(area.y),
      width: Math.round(area.width),
      height: Math.round(area.height)
    },
    cursor: { x: Math.round(cursor.x), y: Math.round(cursor.y) }
  }
}

/**
 * The pointer's position inside the layer, plus which side the caption goes on.
 *
 * The caption sits above the pointer by default: that is the half of the screen
 * the click is *not* about to change. Near the top of the display there is no
 * room, so it flips below.
 */
function measure(): { bounds: ScreenRect; anchor: { x: number; y: number }; side: 'above' | 'below' } {
  const { bounds, cursor } = displayBounds()
  const anchor = { x: cursor.x - bounds.x, y: cursor.y - bounds.y }
  return {
    bounds,
    anchor,
    side: anchor.y < CAPTION_ROOM ? 'below' : 'above'
  }
}

function place(target: BrowserWindow, bounds: ScreenRect): void {
  if (sameRect(placedOn, bounds)) return
  target.setBounds(bounds)
  placedOn = bounds
}

function send(target: BrowserWindow, next: AgentCursorFrame): void {
  frame = next
  if (!target.isDestroyed()) target.webContents.send(CH.agent.cursor, next)
}

/**
 * Paints the current frame at the pointer's current spot and starts following it.
 *
 * Awaiting the window is safe here: the first `arming` event arrives before the
 * run's start delay, so the ring still appears while "приготовился" is on screen.
 */
async function paint(): Promise<void> {
  // A new frame is a new statement: the pending "Смотрю на экран…" describes the
  // pause before this step and would be a lie the moment it arrives.
  cancelWait()
  if (hideTimer) {
    clearTimeout(hideTimer)
    hideTimer = null
  }
  const token = ++paintToken
  const target = await ensureWindow()
  const shown = frame
  if (!target || !shown || token !== paintToken) return

  const spot = measure()
  place(target, spot.bounds)
  send(target, {
    ...shown,
    visible: true,
    anchor: spot.anchor,
    side: spot.side
  })

  if (!visible) {
    visible = true
    // showInactive keeps the user's app frontmost — the assistant is about to
    // operate it, and a focused ring layer would break that.
    target.showInactive()
  }
  startFollow()
}

function startFollow(): void {
  if (follow) return
  follow = setInterval(() => {
    if (!visible || !frame || !win || win.isDestroyed()) return
    const spot = measure()
    // The pointer may have crossed to another display: move the layer once.
    place(win, spot.bounds)
    if (
      spot.anchor.x === frame.anchor.x &&
      spot.anchor.y === frame.anchor.y &&
      spot.side === frame.side
    ) {
      return
    }
    send(win, { ...frame, anchor: spot.anchor, side: spot.side })
  }, FOLLOW_MS)
}

function stopFollow(): void {
  if (follow) {
    clearInterval(follow)
    follow = null
  }
}

/** How long the pause between two plans has to last before the caption changes. */
const WAIT_LABEL_MS = 700

/**
 * Keeps the ring where it is while the turn is still working.
 *
 * Between two plans there is no step to name and no click to mark, but the
 * assistant is not finished: the screen is being read again before it continues.
 * A ring left on the last step would claim a click is still running, and a ring
 * that went out would read as the end of the run. The ring therefore stays on the
 * last step and only relaxes into `waiting` once the pause is long enough to be a
 * pause and not the end of the turn — otherwise the last "Выполнено" would be
 * replaced by a "Смотрю…" that lives for the length of the fade-out.
 *
 * Returns `false` when there is nothing to park (the ring was never shown), so
 * the caller can fall through to a real hide.
 */
function park(): boolean {
  const target = win
  const shown = frame
  if (!shown || !visible || !target || target.isDestroyed()) return false
  if (waitTimer) return true
  // The pause belongs to *this* turn: a newer turn already painting its own step
  // must not be relabelled by a timer the previous one left behind.
  const owner = held
  waitTimer = setTimeout(() => {
    waitTimer = null
    const stillShown = frame
    if (!stillShown || !visible || !win || win.isDestroyed() || held === null) return
    if (held !== owner) return
    // The follow loop keeps running through the pause: the pointer is still the
    // user's, and the ring has to stay on it while the model thinks.
    send(win, {
      ...stillShown,
      visible: true,
      phase: 'waiting',
      label: 'Смотрю на экран…',
      step: 0,
      total: 0
    })
  }, WAIT_LABEL_MS)
  return true
}

function cancelWait(): void {
  if (!waitTimer) return
  clearTimeout(waitTimer)
  waitTimer = null
}

function hide(force = false): void {
  // A turn that is still running keeps the ring: the plan it just finished is a
  // pause, not the end (see `held`). Only `endAgentTurn` — or a stop, an error or
  // a close, which pass `force` — is allowed to take it away.
  if (!force && held !== null && park()) return
  cancelWait()

  // Already fading (or hidden): the pending timer owns the window. Clearing it
  // here would cancel the only thing that actually hides the layer — and the
  // second `hide` call is routine, because the runner publishes `done`/`aborted`
  // and then calls `hideAgentCursor()` again from its `finally`.
  if (!frame) {
    if (!hideTimer) {
      visible = false
      placedOn = null
    }
    return
  }

  const target = win
  const shown = frame
  frame = null
  const token = ++paintToken
  stopFollow()
  if (hideTimer) {
    clearTimeout(hideTimer)
    hideTimer = null
  }
  if (!target || target.isDestroyed()) {
    visible = false
    placedOn = null
    return
  }
  // Let the renderer play its fade-out before the window disappears. The frame
  // stays `null` while hidden, so a late tick cannot resurrect the ring.
  if (!target.isDestroyed()) {
    target.webContents.send(CH.agent.cursor, { ...shown, visible: false })
  }
  hideTimer = setTimeout(() => {
    hideTimer = null
    if (token !== paintToken) return
    if (target && !target.isDestroyed()) target.hide()
    visible = false
    placedOn = null
  }, EXIT_MS)
}

/**
 * Feeds one agent event into the layer.
 *
 * `arming` and `acting` are painted as they come. `done` inside a longer turn
 * parks the ring (see `held`); `done` outside a turn, and `aborted`, `error` and
 * `idle`, mean the pointer belongs to the user again and the ring goes at once.
 * The follow loop stops on the same events, so nothing keeps polling the cursor
 * after the run is over.
 */
export function updateAgentCursor(event: AgentEvent): void {
  // The check between the last action and «Готово» is a real pause with nothing
  // moving, but the turn is not over: the ring stays on the pointer and says
  // what is going on. Letting it fall through to `hide` would read as "готово"
  // half a second before the answer to that question even arrived.
  if (event.phase === 'checking') {
    const shown = frame
    if (!shown || !visible || !win || win.isDestroyed()) return
    // The scheduled "Смотрю на экран…" describes the same pause; cancel it so a
    // later timer cannot overwrite the more specific caption.
    cancelWait()
    send(win, {
      ...shown,
      visible: true,
      phase: 'waiting',
      label: 'Проверяю результат…',
      step: 0,
      total: 0
    })
    return
  }

  if (event.phase !== 'arming' && event.phase !== 'acting') {
    if (event.phase === 'done' && held !== null && park()) return
    hide(true)
    return
  }

  const acting = event.phase === 'acting'
  if (acting) pulse += 1

  const previous = frame
  const label =
    event.label ||
    (acting ? 'Действие' : 'Приготовился')
  const next: AgentCursorFrame = {
    visible: true,
    anchor: previous?.anchor ?? { x: 0, y: 0 },
    side: previous?.side ?? 'above',
    phase: event.phase,
    label,
    step: acting ? event.step : 0,
    total: event.total,
    pulse: acting ? pulse : 0
  }

  frame = next
  void paint()
}

/**
 * Hides the ring unless a turn is still running.
 *
 * This is the safety net the runner calls from its `finally`: after a plan it
 * must not leave a stale mark behind, but between two plans of the same turn it
 * must not take the ring down either. It parks instead, and the turn's own
 * release (`endAgentTurn`) is what finally hides it.
 */
export function hideAgentCursor(): void {
  hide()
}

/**
 * Claims the ring for one agent turn and returns the token that releases it.
 *
 * Called once per turn, before its first plan runs. Until the matching
 * `endAgentTurn` the ring only ever parks, so a turn that runs several plans
 * shows one continuous ring instead of one per plan.
 */
export function beginAgentTurn(): number {
  turn += 1
  // A new request supersedes whatever the previous turn left on screen: a ring
  // parked on a step the user has already moved past would sit there for the
  // length of the new model round, describing work that no longer exists. Turns
  // that finish normally have hidden it in their `finally`, so this only ever
  // fires when two turns overlap.
  if (frame) hide(true)
  held = turn
  return held
}

/** Releases the ring when the turn is really over: the one moment it goes out. */
export function endAgentTurn(token: number): void {
  // A newer turn already owns the ring: this release is stale.
  if (held !== token) return
  held = null
  hide(true)
}

/** Releases the window; called on quit so the layer cannot outlive the app. */
export function destroyAgentCursor(): void {
  stopFollow()
  cancelWait()
  if (hideTimer) {
    clearTimeout(hideTimer)
    hideTimer = null
  }
  paintToken += 1
  visible = false
  placedOn = null
  frame = null
  held = null
  if (win && !win.isDestroyed()) win.destroy()
  win = null
  loaded = null
}
