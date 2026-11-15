/**
 * The numbers the card is built from.
 *
 * None of these may be inlined at a use site: a copy of one of them is exactly
 * how the card ends up clipped or jumping — nothing throws, it just looks wrong.
 * The widths are the strongest case and live one level up, in `@shared/metrics`,
 * because the main process clamps the window to the very same numbers; they are
 * imported under their `CARD_*` names at every use site instead of being
 * re-exported here. Everything below is the renderer's own business.
 *
 * A layout change is a change to this file, and it is checked by eye:
 * the card at rest and unfolded, line wrapping at the narrow/voice/full widths,
 * and the agent row.
 */

/** Outer padding, border and the answer's text-column indent. */
export const ANSWER_CHROME = 8 * 2 + 2 + 12

/** Two buttons' horizontal padding and a small gap between their labels. */
export const ACTIONS_CHROME = ANSWER_CHROME + 5 * 4 + 8

/** The card edge and padding, plus the status icon and gap. */
export const AGENT_ROW_CHROME = 8 * 2 + 2 + 18

/** The extra margin and padding around the status row after the run. */
export const AGENT_STATUS_INSET = 12 + 8 * 2

/**
 * The close button and the gap before it.
 *
 * It is on the line in every state that has the bar: the card can be dismissed
 * with the mouse as well as with Escape.
 */
export const CLOSE_CHROME = 16 + 6

/**
 * Everything on the line that is not the question itself, in points.
 *
 * The card's `padding: 6px 8px` and its 1px edge are 18; the bar spends 6 on the
 * gap before the chevron, 16 on the chevron, and another 6 + 16 on the close
 * button — 62 points of chrome before the field gets a point of its own.
 */
export const CHROME_WIDTH = 8 * 2 + 2 + 6 + 16 + CLOSE_CHROME

/**
 * The stop button, which exists only while an answer streams: its own 18 points
 * and one more gap. Without it the last letters of a spoken phrase would be
 * clipped for as long as the request is in flight.
 */
export const STOP_CHROME = 18 + 6

/**
 * Room for the caret, and for the sub-pixel widths a measured run can lose when
 * the window rounds to whole points. Without it the last letter would sit on the
 * chevron and a word would wrap a keystroke early.
 */
export const CARET_SLACK = 4

/**
 * How tall the field may grow before it scrolls.
 *
 * The same number as `max-height` in `overlay.css`, which is what actually clips
 * the element: a larger cap here would just be a height the CSS then refuses.
 */
export const MAX_FIELD_HEIGHT = 84

/**
 * The field's font, until the live element can be asked for its own.
 *
 * Mirrors `textarea.prompt` in `overlay.css`; the mounted element replaces it
 * through `fieldRef`, so this only covers a measurement taken before the first
 * paint — and the two are the same value.
 */
export const FIELD_FONT = "13px -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Helvetica Neue', Arial, sans-serif"

/**
 * The two places the card prints smaller than the field it measured.
 *
 * `button.link` in the answer's action strip is 11 px and the agent row is
 * 11.5 px, so a width measured in `FIELD_FONT` would over-report both.
 */
export const ACTIONS_FONT = FIELD_FONT.replace('13px', '11px')
export const AGENT_FONT = FIELD_FONT.replace('13px', '11.5px')

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}
