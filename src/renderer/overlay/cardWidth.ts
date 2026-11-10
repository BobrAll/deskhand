/**
 * How wide the card is, as a decision rather than as an expression in a render.
 *
 * Two people choose this number and they must not fight. The card sizes itself
 * to its content, because a bubble that opens as wide as its longest line is a
 * panel parked over the document. The user may then take over — by dragging the
 * edge or by pressing «Шире» — and from that moment the number is theirs.
 *
 * The order is what makes it work: a user width beats both the content and the
 * drawer's request for room, and it survives a re-render, because a card that
 * shrank back the moment the answer reflowed would undo the drag under the
 * hand that made it.
 *
 * Everything here is pure and takes the display width as an argument: the card
 * must not be made wider than the screen it hangs on, and a test has no screen.
 */

import { BUBBLE_MAX_WIDTH, BUBBLE_MIN_WIDTH, BUBBLE_NARROW_WIDTH, BUBBLE_VOICE_WIDTH, BUBBLE_WIDTH } from '@shared/metrics'
import { clamp } from './cardMetrics'

/** Clearance the dragged card leaves at the edges of the display, in points. */
const SCREEN_INSET = 16

/**
 * The widest the user may make the card on a display of `availWidth` points.
 *
 * `BUBBLE_MAX_WIDTH` is a design ceiling; the display is the physical one. On a
 * narrow screen the second is smaller, and a card that cannot fit is not a wider
 * card, it is a card with its right side off the screen.
 */
export function userWidthCeiling(availWidth: number): number {
  return Math.max(BUBBLE_WIDTH, Math.min(BUBBLE_MAX_WIDTH, availWidth - SCREEN_INSET))
}

/**
 * The width a drag has reached.
 *
 * `delta` is measured from the pointer's position when the drag started, not
 * from the previous frame: the window moves while it is being resized, so an
 * incremental sum would feed the card's own motion back into the pointer.
 *
 * `min` is not always the window's floor. While the drawer is unfolded the card
 * cannot be narrower than `BUBBLE_WIDTH` — its buttons need that much — and a drag
 * that ignored it would snap back on release.
 */
export function draggedWidth(
  startWidth: number,
  delta: number,
  availWidth: number,
  min = BUBBLE_MIN_WIDTH
): number {
  return Math.round(clamp(startWidth + delta, min, userWidthCeiling(availWidth)))
}

/**
 * The width «Шире» opens the card to.
 *
 * It is the width the *content* asked for, not the ceiling. Pressing «Шире» on a
 * reply that needs 420 points must give 420 — a button that jumps to 720 leaves
 * a table floating in two-thirds of an empty card, and the next press of
 * «Вернуть» snaps it back past the size it actually wanted.
 *
 * `natural` is the unclamped measurement. Below `BUBBLE_WIDTH` there is nothing to
 * widen — the card already holds the content — so the answer is `null`, and the
 * button is not shown at all.
 */
export function expandedWidth(natural: number, availWidth: number): number | null {
  if (natural <= BUBBLE_WIDTH) return null
  return Math.round(clamp(natural, BUBBLE_WIDTH, userWidthCeiling(availWidth)))
}

export interface WidthInputs {
  /** A voice turn shows the bars and nothing else. */
  showingVoiceBars: boolean
  /** The drawer, a failure or a waiting row needs the full width. */
  wantsWide: boolean
  /** What the content measured out to, chrome included. */
  contentWidth: number
  /** The width the user chose, or `null` while the card sizes itself. */
  userWidth: number | null
  /** The display's available width, in points. */
  availWidth: number
}

/**
 * The width the card actually takes.
 *
 * A voice turn wins over everything: it is bars, and a user width would leave an
 * invisible strip beside them. The user's number comes next, and only then the
 * content — a card the person widened on purpose must not shrink because the
 * answer it holds got shorter.
 *
 * The drawer is the one thing the user's number cannot squeeze: its buttons need
 * `BUBBLE_WIDTH`, so a card dragged down to 200 points opens to the full width when
 * the drawer unfolds, and goes back to 200 when it closes.
 */
export function resolveWidth(input: WidthInputs): number {
  if (input.showingVoiceBars) return BUBBLE_VOICE_WIDTH

  const chosen =
    input.userWidth === null
      ? null
      : Math.round(clamp(input.userWidth, BUBBLE_MIN_WIDTH, userWidthCeiling(input.availWidth)))

  if (chosen !== null) return input.wantsWide ? Math.max(chosen, BUBBLE_WIDTH) : chosen
  if (input.wantsWide) return BUBBLE_WIDTH
  return clamp(input.contentWidth, BUBBLE_NARROW_WIDTH, BUBBLE_WIDTH)
}
