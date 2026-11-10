/**
 * The ghost pointer: a soft, minimal mark that shows where the agent is acting.
 *
 * It is on screen for the whole run, not for one action. Between two clicks it
 * waits where it last was instead of vanishing and reappearing, because a mark
 * that blinks on every step reads as noise while a mark that stays reads as
 * "the agent is still here". It appears when the run starts and leaves when the
 * run ends.
 *
 * Three rules, all of which keep it a visualisation rather than a second
 * implementation:
 *
 * 1. **It never performs anything.** It receives geometry and paints it. There
 *    is no IPC back to the agent, no approval, no retry.
 * 2. **It never blocks.** The window is created lazily and a frame is sent
 *    before it has loaded (the message is queued), so the first action of a run
 *    is not delayed by a page that is still parsing.
 * 3. **It is absent when nobody asked for it.** With `showActions` off the agent
 *    does not emit these events and this module is never touched. A background
 *    run is the same run without a picture.
 *
 * The layer is display-sized and re-placed when a target lands on another
 * display. `from` carries the previous position only when the layer was hidden
 * or moved, so a normal step travels from where the pointer already is.
 */

import { BrowserWindow, screen } from 'electron'
import { CH } from '@shared/ipc'
import type { AgentEvent, AgentPointerFrame, AgentPresentation, ScreenRect } from '@shared/types'
import {
  createLayerWindow,
  ensureLayerWindow,
  placeLayer,
  type LayerWindowState
} from '../layerWindow'

/** The renderer's fade-out; the window is hidden right after it. */
const POINTER_FADE_MS = 240

const layer: LayerWindowState = { window: null, loaded: null }
/** Whether the layer should be on screen; stays true for the whole run. */
let visible = false
/** Where the layer currently sits, so an unchanged display is not re-applied. */
let placedOn: ScreenRect | null = null
/** The last frame, kept so the fade can reuse its geometry. */
let lastFrame: AgentPointerFrame | null = null
/** The last global target, used to animate when the layer changes display. */
let lastPoint: { x: number; y: number } | null = null
let exitTimer: NodeJS.Timeout | null = null
/** Bumped on every paint and hide, so a stale async paint cannot resurrect. */
let paintToken = 0

function createWindow(): BrowserWindow {
  return createLayerWindow({
    page: 'presenter',
    acceptFirstMouse: false,
    onClosed: () => {
      layer.window = null
      layer.loaded = null
      visible = false
      placedOn = null
      lastFrame = null
      lastPoint = null
    }
  })
}

/** The display a global point belongs to, in whole points. */
function displayBounds(point: { x: number; y: number }): ScreenRect {
  const area = screen.getDisplayNearestPoint({ x: Math.round(point.x), y: Math.round(point.y) }).bounds
  return {
    x: Math.round(area.x),
    y: Math.round(area.y),
    width: Math.round(area.width),
    height: Math.round(area.height)
  }
}

/** A global point in the layer's own coordinates. */
function toLayerPoint(point: { x: number; y: number }, bounds: ScreenRect): { x: number; y: number } {
  return { x: Math.round(point.x - bounds.x), y: Math.round(point.y - bounds.y) }
}

/** A global rectangle in the layer's own coordinates. */
function toLayerRect(rect: ScreenRect, bounds: ScreenRect): ScreenRect {
  return {
    x: Math.round(rect.x - bounds.x),
    y: Math.round(rect.y - bounds.y),
    width: Math.round(rect.width),
    height: Math.round(rect.height)
  }
}

/** The middle of a rectangle, or null when there is no rectangle. */
function rectCenter(rect: ScreenRect | undefined): { x: number; y: number } | null {
  if (!rect) return null
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
}

/** Keeps a start point inside the layer, so the pointer enters from an edge. */
function clampToLayer(point: { x: number; y: number }, bounds: ScreenRect): { x: number; y: number } {
  return {
    x: Math.min(Math.max(point.x, 0), bounds.width),
    y: Math.min(Math.max(point.y, 0), bounds.height)
  }
}

/** Whether the layer had to move; the caller animates the jump when it did. */
function place(target: BrowserWindow, bounds: ScreenRect): boolean {
  const placement = placeLayer(target, placedOn, bounds)
  placedOn = placement.placedOn
  return placement.moved
}

function send(target: BrowserWindow, frame: AgentPointerFrame): void {
  lastFrame = frame
  if (!target.isDestroyed()) target.webContents.send(CH.agent.presentation, frame)
}

function cancelExit(): void {
  if (exitTimer) {
    clearTimeout(exitTimer)
    exitTimer = null
  }
}

/**
 * Where the pointer should wait before it has been given a target: the real
 * pointer, which is where the user is looking and where the card was opened.
 */
function restingPoint(): { x: number; y: number } {
  const cursor = screen.getCursorScreenPoint()
  return { x: Math.round(cursor.x), y: Math.round(cursor.y) }
}

/**
 * Shows the pointer for the duration of a run, before the first action.
 *
 * Idempotent: a run publishes several phases and every one of them may ask for
 * the mark, but only the first actually creates and shows the window. The frame
 * is marked `idle` so the renderer does not ripple or press for a gesture that
 * has not happened yet.
 */
export function showAgentPointer(): void {
  void reveal()
}

async function reveal(): Promise<void> {
  if (visible) return
  const token = ++paintToken
  const target = await ensureLayerWindow(layer, createWindow, { watchDestroyed: true })
  if (!target || token !== paintToken || visible) return

  const point = restingPoint()
  const bounds = displayBounds(point)
  place(target, bounds)
  send(target, {
    visible: true,
    idle: true,
    point: toLayerPoint(point, bounds)
  })
  lastPoint = point
  visible = true
  // showInactive: the user's app stays frontmost while the pointer is drawn over
  // it. The agent raises the target window itself, in its own process.
  target.showInactive()
}

/**
 * Draws one action. Fire-and-forget: the caller is the agent's event handler,
 * and the action it describes has already been allowed and is about to run.
 */
export function presentAgentAction(action: AgentPresentation): void {
  const point = action.point ?? rectCenter(action.target) ?? rectCenter(action.window)
  // A key press into an app that was never read has no point. The window still
  // came forward (the agent does that), and inventing a position would point the
  // user at a control the action never named. The mark stays where it is.
  if (!point) return
  void paint(action, point)
}

async function paint(action: AgentPresentation, point: { x: number; y: number }): Promise<void> {
  cancelExit()
  const token = ++paintToken
  const target = await ensureLayerWindow(layer, createWindow, { watchDestroyed: true })
  if (!target || token !== paintToken) return

  const bounds = displayBounds(point)
  const moved = place(target, bounds)
  const cursor = screen.getCursorScreenPoint()
  const cursorInside =
    cursor.x >= bounds.x &&
    cursor.x <= bounds.x + bounds.width &&
    cursor.y >= bounds.y &&
    cursor.y <= bounds.y + bounds.height

  // Start where the eye already is: the real pointer on the first frame, or the
  // last target when the layer had to move to another display. On a normal step
  // there is no `from`; the renderer transitions from its current position.
  const from = !visible
    ? (cursorInside ? toLayerPoint(cursor, bounds) : null)
    : moved && lastPoint
      ? clampToLayer(toLayerPoint(lastPoint, bounds), bounds)
      : null

  send(target, {
    visible: true,
    idle: false,
    point: toLayerPoint(point, bounds),
    gesture: action.gesture,
    ...(from ? { from } : {}),
    ...(action.target ? { target: toLayerRect(action.target, bounds) } : {})
  })
  lastPoint = point
  if (!visible) {
    visible = true
    target.showInactive()
  }
}

/**
 * Feeds one agent phase into the layer.
 *
 * The mark is present for the whole run, so the phases that mean "still working"
 * keep it up and the terminal ones take it down. It is not tied to a step: a run
 * that is waiting on the model, or on a question, is still a run.
 *
 * Kept here rather than in the overlay so the lifetime has one owner and one
 * test, the same way `updateAgentCursor` owns the glow's.
 */
export function updateAgentPointer(event: AgentEvent): void {
  switch (event.phase) {
    case 'arming':
    case 'acting':
    case 'asking':
      showAgentPointer()
      return
    case 'done':
    case 'aborted':
    case 'error':
    case 'idle':
      hideAgentPresentation()
      return
  }
}

/** Fades the pointer out and hides the layer after the animation. */
function hide(): void {
  cancelExit()
  // Bumped even when nothing is on screen: a paint that is still waiting for the
  // page to load must not show the layer after the run it belonged to has ended.
  const token = ++paintToken
  if (!visible) return
  const target = layer.window
  const frame = lastFrame
  if (!target || target.isDestroyed()) {
    visible = false
    placedOn = null
    lastFrame = null
    lastPoint = null
    return
  }
  if (frame) {
    // Keep `visible` true until the window is actually hidden: a new action
    // arriving inside the fade must cancel it, not be treated as a fresh start.
    target.webContents.send(CH.agent.presentation, { ...frame, visible: false })
  }
  exitTimer = setTimeout(() => {
    exitTimer = null
    if (token !== paintToken) return
    if (target && !target.isDestroyed()) target.hide()
    visible = false
    placedOn = null
    lastFrame = null
    lastPoint = null
  }, POINTER_FADE_MS)
}

/**
 * Takes the pointer down at the end of a run.
 *
 * Called on every terminal phase (`done`, `aborted`, `error`, `idle`). There is
 * deliberately no idle timeout: a run can spend half a minute waiting on the
 * model, and a mark that disappeared during the wait would be describing the
 * pause instead of the work. The run's own end is the only thing that removes
 * it, and that end is always published.
 */
export function hideAgentPresentation(): void {
  hide()
}

/** Releases the window; called on quit so the layer cannot outlive the app. */
export function destroyAgentPresentation(): void {
  cancelExit()
  paintToken += 1
  visible = false
  placedOn = null
  lastFrame = null
  lastPoint = null
  const target = layer.window
  if (target && !target.isDestroyed()) target.destroy()
  layer.window = null
  layer.loaded = null
}
