/**
 * A display-sized glow with a status caption that follows the pointer.
 * The window passes clicks through, stays unfocused and is excluded from captures.
 */

import { BrowserWindow, screen } from 'electron'
import { CH } from '@shared/ipc'
import type { AgentCursorFrame, AgentEvent, ScreenRect } from '@shared/types'
import { trace } from './trace'
import {
  createLayerWindow,
  ensureLayerWindow,
  placeLayer,
  type LayerWindowState
} from '../layerWindow'

/** How long the renderer's fade-out runs before the window is actually hidden. */
const CURSOR_FADE_MS = 160
const SUCCESS_MS = 1100

/**
 * Follow rate. 16 ms is roughly one display frame: the helper warps the pointer
 * in one jump, so anything slower would show the caption arriving after the click.
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

/** How long the pause between two plans has to last before the caption changes. */
const WAIT_LABEL_MS = 700

const layer: LayerWindowState = { window: null, loaded: null }
let visible = false
/** Where the layer was last put, so an unchanged display is not re-applied. */
let placedOn: ScreenRect | null = null
/** The frame currently being painted; `null` while hidden. */
let frame: AgentCursorFrame | null = null
let follow: NodeJS.Timeout | null = null
let hideTimer: NodeJS.Timeout | null = null
/** Bumped on every paint, so a stale fade-out cannot hide a new step. */
let paintToken = 0
/**
 * The turn that currently owns the glow, if any.
 *
 * A turn is not one plan: the model may look at the screen again and continue,
 * and every plan ends with `done`. Hiding on that `done` made the glow go out
 * between two plans and come back a moment later — the user saw the mark blink
 * mid-run and could not tell a pause from the end. While a turn holds the glow,
 * a finished plan parks it in `waiting` instead of hiding it, and only
 * `endAgentTurn` takes it away.
 *
 * The token, not a flag, is what keeps a slow turn from being un-held by an
 * older one: the previous request can finish after the next one has already
 * started, and its release must not take the new turn's glow down.
 */
let glowOwner: number | null = null
let turnCount = 0
/** Stage a `done` into `waiting` after a beat; cancelled by the next step. */
let waitTimer: NodeJS.Timeout | null = null
let successTimer: NodeJS.Timeout | null = null

function cancelSuccess(): void {
  if (successTimer) clearTimeout(successTimer)
  successTimer = null
}

function createWindow(): BrowserWindow {
  return createLayerWindow({
    page: 'cursor',
    acceptFirstMouse: false,
    caseless: true,
    onClosed: () => {
      layer.window = null
      layer.loaded = null
      visible = false
      placedOn = null
      frame = null
    }
  })
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
  placedOn = placeLayer(target, placedOn, bounds).placedOn
}

function send(target: BrowserWindow, next: AgentCursorFrame): void {
  frame = next
  if (!target.isDestroyed()) target.webContents.send(CH.agent.cursor, next)
}

/**
 * Paints the glow on the active display and starts following the pointer for the caption.
 *
 * Awaiting the window is safe here: the first `arming` event arrives before the
 * run's start delay, so the glow still appears while "приготовился" is on screen.
 */
async function paint(): Promise<void> {
  cancelSuccess()
  // A new frame is a new statement: the pending "Смотрю на экран…" describes the
  // pause before this step and would be a lie the moment it arrives.
  cancelWait()
  if (hideTimer) {
    clearTimeout(hideTimer)
    hideTimer = null
  }
  const token = ++paintToken
  const target = await ensureLayerWindow(layer, createWindow, { watchDestroyed: true })
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
    trace('cursor.show', { phase: shown.phase })
    // showInactive keeps the user's app frontmost — the assistant is about to
    // operate it, and a focused glow layer would break that.
    target.showInactive()
  }
  startFollow()
  if (shown.phase === 'success') {
    successTimer = setTimeout(() => {
      successTimer = null
      if (token === paintToken) hideNow()
    }, SUCCESS_MS)
  }
}

function startFollow(): void {
  if (follow) return
  follow = setInterval(() => {
    const target = layer.window
    if (!visible || !frame || !target || target.isDestroyed()) return
    const spot = measure()
    // The pointer may have crossed to another display: move the layer once.
    place(target, spot.bounds)
    if (
      spot.anchor.x === frame.anchor.x &&
      spot.anchor.y === frame.anchor.y &&
      spot.side === frame.side
    ) {
      return
    }
    send(target, { ...frame, anchor: spot.anchor, side: spot.side })
  }, FOLLOW_MS)
}

function stopFollow(): void {
  if (follow) {
    clearInterval(follow)
    follow = null
  }
}

/**
 * Keeps the glow visible while the turn is still working.
 *
 * Between two plans there is no step to name and no click to mark, but the
 * assistant is not finished: the screen is being read again before it continues.
 * Wait briefly before replacing the last step caption with "Смотрю…", since
 * the turn might finish before the new caption would be readable.
 *
 * Returns `false` when there is nothing to park (the glow was never shown), so
 * the caller can fall through to a real hide.
 */
function park(): boolean {
  const target = layer.window
  const shown = frame
  if (!shown || !visible || !target || target.isDestroyed()) return false
  if (waitTimer || shown.phase === 'waiting') return true
  // The pause belongs to *this* turn: a newer turn already painting its own step
  // must not be relabelled by a timer the previous one left behind.
  const owner = glowOwner
  waitTimer = setTimeout(() => {
    waitTimer = null
    const stillShown = frame
    const stillTarget = layer.window
    if (!stillShown || !visible || !stillTarget || stillTarget.isDestroyed() || glowOwner === null) return
    if (glowOwner !== owner) return
    send(stillTarget, {
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

/** Fades the glow out and hides the layer, unless `immediate` skips the park. */
function hide(immediate = false): void {
  if (!immediate && frame?.phase === 'success') return
  cancelSuccess()
  // A turn that is still running keeps the glow: the plan it just finished is a
  // pause, not the end (see `glowOwner`). Only `endAgentTurn` — or a stop, an
  // error or a close, which are immediate — is allowed to take it away.
  if (!immediate && glowOwner !== null && park()) return
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

  const target = layer.window
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
  trace('cursor.fade', { phase: shown.phase })
  // Let the renderer play its fade-out before the window disappears. The frame
  // stays `null` while hidden, so a late tick cannot resurrect the glow.
  target.webContents.send(CH.agent.cursor, { ...shown, visible: false })
  hideTimer = setTimeout(() => {
    hideTimer = null
    if (token !== paintToken) return
    if (target && !target.isDestroyed()) target.hide()
    visible = false
    placedOn = null
  }, CURSOR_FADE_MS)
}

/** Takes the glow down now, whatever the turn is doing. */
function hideNow(): void {
  hide(true)
}

/** The success frame: a green check for a run that finished. */
function paintSuccess(): void {
  frame = {
    visible: true,
    anchor: frame?.anchor ?? { x: 0, y: 0 },
    side: frame?.side ?? 'above',
    phase: 'success',
    label: 'Готово',
    step: 0,
    total: 0
  }
  void paint()
}

/**
 * The glow parks with the question, so the eye goes to the card instead of
 * following a caption that says nothing new.
 */
function paintQuestion(event: AgentEvent): void {
  if (!frame && glowOwner === null) return
  cancelWait()
  const waiting: AgentCursorFrame = {
    visible: true,
    anchor: frame?.anchor ?? { x: 0, y: 0 },
    side: frame?.side ?? 'above',
    phase: 'waiting',
    label: event.label || 'Нужно подтверждение',
    step: 0,
    total: 0
  }
  trace('cursor.waiting', { asking: true })
  const target = layer.window
  if (visible && target && !target.isDestroyed()) send(target, waiting)
  else {
    frame = waiting
    void paint()
  }
}

/** A step of a run: the caption moves with the work. */
function paintStep(event: AgentEvent, phase: 'arming' | 'acting'): void {
  const acting = phase === 'acting'
  const previous = frame
  const label =
    event.label ||
    (acting ? 'Действие' : 'Приготовился')
  const next: AgentCursorFrame = {
    visible: true,
    anchor: previous?.anchor ?? { x: 0, y: 0 },
    side: previous?.side ?? 'above',
    phase,
    label,
    step: acting ? event.step : 0,
    total: event.total
  }

  frame = next
  void paint()
}

/**
 * Feeds one agent event into the layer.
 *
 * `arming` and `acting` are painted as they come. `done` inside a longer turn
 * parks the glow (see `glowOwner`); `done` outside a turn, and `aborted`, `error`
 * and `idle`, mean the pointer belongs to the user again and the glow goes at
 * once. The follow loop stops on the same events, so nothing keeps polling the
 * cursor after the run is over.
 */
export function updateAgentCursor(event: AgentEvent): void {
  if (event.phase === 'done' && event.completed) {
    paintSuccess()
    return
  }
  // A run that is waiting for the user to answer is not progress and not a
  // failure: the pointer glow parks with the question.
  if (event.phase === 'asking') {
    paintQuestion(event)
    return
  }

  if (event.phase !== 'arming' && event.phase !== 'acting') {
    if (event.phase === 'done' && glowOwner !== null && park()) return
    hideNow()
    return
  }

  paintStep(event, event.phase)
}

/**
 * Hides the glow unless a turn is still running.
 *
 * This is the safety net the runner calls from its `finally`: after a plan it
 * must not leave a stale mark behind, but between two plans of the same turn it
 * must not take the glow down either. It parks instead, and the turn's own
 * release (`endAgentTurn`) is what finally hides it.
 */
export function hideAgentCursor(): void {
  hide()
}

/**
 * Claims the glow for one agent turn and returns the token that releases it.
 *
 * Called once per turn, before its first plan runs. Until the matching
 * `endAgentTurn` the glow only ever parks, so a turn that runs several plans
 * shows one continuous glow instead of one per plan.
 */
export function beginAgentTurn(label?: string): number {
  turnCount += 1
  // A new request supersedes the previous turn's glow and caption.
  if (frame) hideNow()
  glowOwner = turnCount
  if (label) {
    frame = { visible: true, anchor: { x: 0, y: 0 }, side: 'above',
      phase: 'waiting', label, step: 0, total: 0 }
    void paint()
  }
  return glowOwner
}

/** Releases the glow when the turn is really over: the one moment it goes out. */
export function endAgentTurn(token: number): void {
  // A newer turn already owns the glow: this release is stale.
  if (glowOwner !== token) return
  glowOwner = null
  if (frame?.phase !== 'success') hideNow()
}

/** Releases the window; called on quit so the layer cannot outlive the app. */
export function destroyAgentCursor(): void {
  cancelSuccess()
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
  glowOwner = null
  const target = layer.window
  if (target && !target.isDestroyed()) target.destroy()
  layer.window = null
  layer.loaded = null
}
