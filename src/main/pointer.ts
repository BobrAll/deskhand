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

import type { BrowserWindow } from 'electron'
import { CH } from '@shared/ipc'
import type { Annotation, PointerPayload, PointerShape, ScreenRect } from '@shared/types'
import {
  createLayerWindow,
  ensureLayerWindow,
  placeLayer,
  type LayerWindowState
} from './layerWindow'
import { watchForAbort, type AbortWatcher } from './native/helper'

/** The renderer's fade-out; the window is hidden right after it. */
const DRAWING_FADE_MS = 240
/** The smallest ring a single-point circle is drawn as, in points. */
const MIN_RING_RADIUS = 16
/** Clearance around a ring, so it does not touch the target's edge. */
const RING_PADDING = 6

const layer: LayerWindowState = { window: null, loaded: null }
let interactionWatcher: AbortWatcher | null = null
let visible = false
let revision = 0

/** Where the layer currently sits; re-positioning on every draw would flicker. */
let placedOn: ScreenRect | null = null

/** Drops everything that belonged to the window that just went away. */
function resetPointerState(): void {
  interactionWatcher?.stop()
  interactionWatcher = null
  visible = false
  placedOn = null
  layer.loaded = null
}

function createWindow(): BrowserWindow {
  return createLayerWindow({
    page: 'pointer',
    acceptFirstMouse: true,
    onClosed: () => {
      resetPointerState()
      layer.window = null
    }
  })
}

function placeOn(win: BrowserWindow, area: ScreenRect): void {
  placedOn = placeLayer(win, placedOn, area, true).placedOn
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
    const cx = (x1 + x2) / 2
    const cy = (y1 + y2) / 2
    const radiusX = Math.max(Math.abs(x2 - x1) / 2, MIN_RING_RADIUS)
    const radiusY = Math.max(Math.abs(y2 - y1) / 2, MIN_RING_RADIUS)
    return {
      id: `${index}`,
      kind: annotation.kind,
      from: {
        x: Math.max(0, cx - radiusX - RING_PADDING),
        y: Math.max(0, cy - radiusY - RING_PADDING)
      },
      to: {
        x: Math.min(width, cx + radiusX + RING_PADDING),
        y: Math.min(height, cy + radiusY + RING_PADDING)
      },
      label: annotation.label
    }
  })
}

/** Draws `annotations` over the screen and makes the layer visible. */
export async function showAnnotations(area: ScreenRect, annotations: Annotation[], onDismiss?: () => void): Promise<void> {
  if (annotations.length === 0) {
    hideAnnotations()
    return
  }
  const win = await ensureLayerWindow(layer, createWindow)
  if (!win) return

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
    interactionWatcher = watchForAbort({ watchMouse: false, interaction: true }, () => {
      hideAnnotations()
      onDismiss?.()
    })
  }
}

export function hideAnnotations(): void {
  interactionWatcher?.stop()
  interactionWatcher = null
  visible = false
  const win = layer.window
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
    const current = layer.window
    if (current && !current.isDestroyed() && !visible) current.hide()
  }, DRAWING_FADE_MS)
}

export function destroyPointer(): void {
  resetPointerState()
  const win = layer.window
  if (win && !win.isDestroyed()) win.destroy()
  layer.window = null
}
