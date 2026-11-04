/**
 * Coordinate mapping between what the model sees and where the pointer goes.
 *
 * The model is shown a JPEG that was scaled down and re-encoded, so it never
 * knows pixels — it returns fractions of the frame it was given. This module is
 * the single place those fractions become screen points, and it is deliberately
 * its own file: the mapping is the one piece of arithmetic in the agent that can
 * be wrong in a way nobody notices until a click lands in the wrong window.
 *
 * Pure module: no Electron, no Node, so it can be tested on its own.
 */

import type { Point01, ScreenRect } from '@shared/types'

/** A point in global screen points, top-left origin — the space Electron uses. */
export interface ScreenPoint {
  x: number
  y: number
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(1, Math.max(0, value))
}

/**
 * Fraction of the captured frame → global screen points.
 *
 * `area` is the rectangle the screenshot was taken from, in points, exactly as
 * `ScreenshotInfo.area` records it. Because the fractions are relative to the
 * frame rather than to pixels, a Retina capture and a Retina-sized window agree
 * without any scale factor: only the frame's own origin and size matter.
 */
export function toScreenPoint(point: Point01, area: ScreenRect): ScreenPoint {
  return {
    x: area.x + clamp01(point.x) * area.width,
    y: area.y + clamp01(point.y) * area.height
  }
}

/**
 * Where a point sits in the frame, 0..1.
 *
 * Used for the reverse direction — describing a position the user can recognise
 * ("остановился у правого края") — and for tests that assert a round trip.
 */
export function toFramePoint(point: ScreenPoint, area: ScreenRect): Point01 {
  const width = area.width || 1
  const height = area.height || 1
  return {
    x: clamp01((point.x - area.x) / width),
    y: clamp01((point.y - area.y) / height)
  }
}