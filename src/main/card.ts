/**
 * Where the card goes.
 *
 * The overlay is not a window the user positions: it appears next to the pointer,
 * grows as the answer streams in, and must never cover the thing it is talking
 * about. Every decision that follows from that is arithmetic on numbers — the
 * pointer, the display's work area, the requested size — so it lives here as pure
 * functions and is tested with real numbers instead of a fake `BrowserWindow`.
 *
 * The two `screen.*` lookups that the arithmetic needs stay with the caller
 * (`windows/index.ts`) and arrive as arguments: a work area for the pointer, a work area
 * for a card the user dragged to another display.
 *
 * The rules, in the order they matter:
 *
 * - The card opens down-and-right of the pointer, flips left near the right edge
 *   and above near the bottom edge — the shortest path to "it appeared where I was
 *   looking", with the pointer never covered.
 * - The side chosen at placement is *kept*. A card that hopped over the pointer
 *   because one more letter no longer fitted would move out from under the eyes
 *   reading it, which is worse than the card growing into the pointer's own
 *   column. Growing pushes the far edge away, and near a display edge the far edge
 *   is what gets pinned.
 * - A card the user dragged away is left where they put it and grows from there:
 *   yanking it back to the old pointer position mid-answer would move the text out
 *   from under the eyes that are reading it.
 */

import type { ScreenRect } from '@shared/types'
import { clamp } from './util'

/** Clearance between the pointer and the card, in points. */
export const CARD_GAP = 10

/** How close the card may get to a display edge. */
export const CARD_MARGIN = 8

/**
 * Height of the folded card — one input line and the chevron — before the
 * renderer has laid itself out.
 */
export const CARD_FOLDED_HEIGHT = 31

/** How far the window may drift from where it was placed before it counts as dragged. */
const DRAG_SLACK = 2

/**
 * A point in global screen points.
 *
 * Not `Point01` from `@shared/types`: that one is documented as normalised image
 * coordinates, and passing a screen point where an annotation point is expected
 * is the mistake the two names exist to keep apart.
 */
export interface ScreenPoint {
  x: number
  y: number
}

/**
 * Where the card hangs off the pointer.
 *
 * Kept for the lifetime of one showing: the answer streams in and the card
 * grows, and a rectangle re-placed from scratch on every height change would
 * drift away from the cursor (and, worse, hop above it mid-answer). The pointer
 * position, the side it was placed on and the horizontal edge are therefore
 * remembered once and only the vertical edge is recomputed.
 */
export interface CardAnchor {
  /** The pointer at the moment the card appeared, in global screen points. */
  point: ScreenPoint
  area: ScreenRect
  /** Left edge of the card; it may sit left of the pointer when flipped. */
  x: number
  /** `true` when the card hangs above the pointer instead of below it. */
  above: boolean
  /**
   * The side of the pointer the card hangs on.
   *
   * Remembered because the card *grows sideways*: it opens as a 112 pt pill and
   * widens with every letter typed, so the horizontal edge has to be computed
   * from the width each time instead of being frozen at the size it opened with.
   * The side is the part that stays.
   */
  right: boolean
  /**
   * The horizontal edge belongs to the user: they dragged the card, or pulled its
   * edge to make it wider.
   *
   * Once set, the left edge is kept and only the far edge moves. A card that
   * jumped back to the pointer the moment its content reflowed would undo the
   * drag under the hand that made it.
   */
  pinned?: boolean
}

/** Remaining room on either side of the pointer, inside the given work area. */
export function roomAround(
  point: ScreenPoint,
  area: ScreenRect
): { below: number; above: number } {
  return {
    below: area.y + area.height - CARD_MARGIN - (point.y + CARD_GAP),
    above: point.y - CARD_GAP - (area.y + CARD_MARGIN)
  }
}

/**
 * The horizontal edge for a given width.
 *
 * The side chosen at placement is kept: growing pushes the *far* edge away, and
 * near a display edge the far edge is what gets pinned — the card slides just
 * enough to stay on screen.
 */
export function xFor(placed: CardAnchor, width: number): number {
  const min = placed.area.x + CARD_MARGIN
  const max = Math.max(min, placed.area.x + placed.area.width - width - CARD_MARGIN)
  const wanted = placed.right ? placed.point.x + CARD_GAP : placed.point.x - width - CARD_GAP
  return clamp(wanted, min, max)
}

/** The vertical edge for a given height, clamped so the card stays on screen. */
export function yFor(placed: CardAnchor, height: number): number {
  const raw = placed.above ? placed.point.y - CARD_GAP - height : placed.point.y + CARD_GAP
  const max = placed.area.y + placed.area.height - height - CARD_MARGIN
  return clamp(
    raw,
    placed.area.y + CARD_MARGIN,
    Math.max(placed.area.y + CARD_MARGIN, max)
  )
}

/**
 * Records the anchor for a card of the given size (ТЗ §8: next to the cursor).
 *
 * Placed down-and-right of the pointer, flipped left near the right edge and
 * above near the bottom edge.
 */
export function placeAnchor(
  point: ScreenPoint,
  area: ScreenRect,
  height: number,
  width: number
): CardAnchor {
  const right = point.x + CARD_GAP + width <= area.x + area.width - CARD_MARGIN

  const room = roomAround(point, area)
  const placed: CardAnchor = {
    point,
    area,
    x: 0,
    above: height > room.below && height <= room.above,
    right
  }
  placed.x = xFor(placed, width)
  return placed
}

/** The window rectangle for an anchor and a size. */
export function boundsFor(anchor: CardAnchor, height: number, width: number): ScreenRect {
  return {
    x: Math.round(anchor.x),
    y: Math.round(yFor(anchor, height)),
    width: Math.round(width),
    height: Math.round(height)
  }
}

/**
 * Re-applies a remembered anchor to a new size.
 *
 * Both edges are re-derived, because both dimensions change while a turn runs:
 * the card widens with every letter typed and grows downwards as the answer
 * arrives. What stays is the *anchor* — the pointer it was placed against and the
 * sides it was placed on — so the card grows away from the pointer instead of
 * crawling out from under it.
 *
 * `pin` says the horizontal edge is the user's: they dragged the card or pulled
 * its edge. The left edge then stays where it is and only the far edge moves,
 * which is the only way a right-edge drag can keep the edge under the pointer.
 * The anchor remembers the decision (`pinned`), because the next content-driven
 * resize must not pull the card back to the pointer mid-answer.
 */
export interface ResizeAnchorOptions {
  anchor: CardAnchor
  /** The window's current rectangle, as Electron reports it. */
  bounds: ScreenRect
  height: number
  width: number
  /**
   * The caller's `screen.getDisplayNearestPoint(...).workArea`: the pointer may
   * have been on another display when the card opened, and a card the user
   * dragged away has to stay inside the work area of *that* display.
   */
  workAreaAt(point: ScreenPoint): ScreenRect
  /** The horizontal edge is the user's: they dragged the card or pulled its edge. */
  pin?: boolean
}

export function resizeAnchor(options: ResizeAnchorOptions): CardAnchor {
  const { anchor, bounds, height, width, workAreaAt, pin = false } = options
  const placed: CardAnchor = { ...anchor, point: { ...anchor.point } }
  placed.area = workAreaAt(placed.point)

  const dragged =
    pin ||
    Boolean(anchor.pinned) ||
    Math.abs(bounds.x - placed.x) > DRAG_SLACK ||
    Math.abs(bounds.y - yFor(placed, bounds.height)) > DRAG_SLACK

  if (dragged) {
    placed.area = workAreaAt({ x: bounds.x, y: bounds.y })
    // Re-derive the pointer from the current top edge, so the height change keeps
    // the edge the user chose instead of the one it was placed with. The
    // horizontal edge stays where the card was dropped — it is the user's choice —
    // and is only pulled back when growing wider would carry it off the display.
    const min = placed.area.x + CARD_MARGIN
    const max = Math.max(min, placed.area.x + placed.area.width - width - CARD_MARGIN)
    placed.x = clamp(bounds.x, min, max)
    placed.point = {
      x: placed.point.x,
      y: placed.above ? bounds.y + bounds.height + CARD_GAP : bounds.y - CARD_GAP
    }
    // From here on the horizontal edge belongs to the user, including a resize
    // that happens after the drag has ended.
    if (pin) placed.pinned = true
  } else {
    const room = roomAround(placed.point, placed.area)
    if (height > room.below && height <= room.above) placed.above = true
    else if (height > room.above && height <= room.below) placed.above = false
    // The width changed with the text, so the horizontal edge is re-derived too:
    // the card widens away from the pointer instead of running off the display.
    placed.x = xFor(placed, width)
  }

  return placed
}
