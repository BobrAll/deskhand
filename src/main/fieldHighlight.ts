/**
 * The transparent border around the field a dictation is about to fill.
 *
 * It is a layer window, not part of the overlay: the overlay sits at the cursor
 * and is where the bars live, while this border has to sit exactly on the
 * user's own text field. `createLayerWindow` already gives the three properties
 * that matter here — never focusable, never eats clicks, never appears in a
 * screenshot — so the rest is placement and a show/hide message.
 *
 * The window is hidden, not destroyed, between holds: the next press reuses the
 * loaded page, and a border that is no longer relevant cannot linger on screen.
 */

import type { BrowserWindow } from 'electron'
import { CH } from '@shared/ipc'
import type { ScreenRect } from '@shared/types'
import {
  createLayerWindow,
  ensureLayerWindow,
  placeLayer,
  type LayerWindowState
} from './layerWindow'

/**
 * The strip is a listening bar, not a repaint of the whole editor.
 *
 * A single-line field is used as-is; a tall text area would otherwise become a
 * dark wall of glass, so the strip stays a compact band in the middle of it.
 */
const MAX_STRIP_HEIGHT = 46

const layer: LayerWindowState = { window: null, loaded: null }
let placedOn: ScreenRect | null = null
/** Whether the strip is currently on screen. */
let visible = false
/** Latest microphone level, so a late layer still opens at the right amplitude. */
let level = 0
/**
 * Which request owns the layer right now.
 *
 * Reading the focused field is asynchronous, and a hold can end — or a new one
 * start — before that answer lands. A late answer must not paint a border over
 * the next app, so every show/hide bumps this token.
 */
let token = 0

function createWindow(): BrowserWindow {
  return createLayerWindow({
    page: 'highlight',
    acceptFirstMouse: false,
    // The strip is the same glass as the card: native frost behind a tinted
    // surface, clipped to the rounded window so no square blur leaks out.
    vibrancy: 'under-window',
    roundedCorners: true,
    onClosed: () => {
      layer.window = null
      layer.loaded = null
      placedOn = null
      visible = false
      level = 0
    }
  })
}

/** The window's bounds: exactly the field, or a compact band inside a tall one. */
function highlightFrame(frame: ScreenRect): ScreenRect {
  const height = Math.max(1, Math.min(frame.height, MAX_STRIP_HEIGHT))
  return {
    x: Math.round(frame.x),
    // Centre the band in a tall editor; a single-line field has nowhere to go.
    y: Math.round(frame.y + (frame.height - height) / 2),
    width: Math.max(1, Math.round(frame.width)),
    height: Math.round(height)
  }
}

/** Marks `frame` as the insertion target, or drops the mark when it is null. */
export async function showFieldHighlight(frame: ScreenRect | null): Promise<void> {
  const mine = ++token
  if (!frame) {
    hideFieldHighlight()
    return
  }
  const target = await ensureLayerWindow(layer, createWindow, { watchDestroyed: true })
  if (!target || target.isDestroyed() || mine !== token) return
  placedOn = placeLayer(target, placedOn, highlightFrame(frame)).placedOn
  visible = true
  target.webContents.send(CH.voice.fieldHighlight, { visible: true, level })
  target.showInactive()
}

/** Removes the strip without waiting for a pending layer load. */
export function hideFieldHighlight(): void {
  token += 1
  visible = false
  level = 0
  const target = layer.window
  if (!target || target.isDestroyed()) return
  target.webContents.send(CH.voice.fieldHighlight, { visible: false, level: 0 })
  target.hide()
}

/** Feeds the microphone meter to the strip while it is on screen. */
export function setFieldLevel(next: number): void {
  level = Math.max(0, Math.min(1, next))
  if (!visible) return
  const target = layer.window
  if (!target || target.isDestroyed()) return
  target.webContents.send(CH.voice.fieldHighlight, { visible: true, level })
}
