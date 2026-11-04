/**
 * The numbers the card is built from.
 *
 * None of these may be inlined at a use site: a copy of one of them is exactly
 * how the card ends up clipped or jumping — nothing throws, it just looks wrong.
 * The three widths are the strongest case and live one level up, in
 * `@shared/metrics`, because the main process clamps the window to the very same
 * numbers; everything here is the renderer's own business.
 *
 * A layout change is a change to this file, and it is checked by eye:
 * `MANUAL_SMOKE §2.1` (the card at rest and unfolded), §4 (line wrapping at
 * 112/80/360) and §7 (the agent row).
 */

import { BUBBLE_NARROW_WIDTH, BUBBLE_VOICE_WIDTH, BUBBLE_WIDTH } from '@shared/metrics'
import type { RefineDirection } from '@shared/types'

/**
 * Card widths, in the same points the main process clamps the window to.
 *
 * The folded, empty card is a small pill — roughly three times as wide as the one
 * line it is tall, which is what makes it read as a foothold on the screen rather
 * than a panel. It does not jump to a fixed width when typing starts: it grows by
 * the width of each glyph as it is typed, and only wraps onto a second line once
 * the question no longer fits in `FULL_WIDTH`. A panel that doubles in size on
 * the first keystroke is loud at exactly the moment a person is still deciding
 * whether they have anything to say.
 */
export const NARROW_WIDTH = BUBBLE_NARROW_WIDTH

/** While a voice turn runs the card is nothing but the bars, so it shrinks to them. */
export const VOICE_WIDTH = BUBBLE_VOICE_WIDTH

/** The widest the card gets, whether it is a question or an answer inside it. */
export const FULL_WIDTH = BUBBLE_WIDTH

/**
 * Everything on the line that is not the question itself, in points.
 *
 * The bubble's `padding: 6px 8px` and its 1px edge are 18; the bar spends 6 on the
 * presence dot, 6 + 6 on the two gaps and 16 on the chevron — 52 points of chrome
 * before the field gets a single point of its own.
 */
export const CHROME_WIDTH = 8 * 2 + 2 + 6 + 6 + 6 + 16

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
export const FIELD_FONT =
  "13px -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Helvetica Neue', Arial, sans-serif"

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

/**
 * The two rewrite buttons under a finished answer.
 *
 * `label` is what the button says; `hint` is the tooltip, which is where the
 * difference between them is actually explained — "Короче" alone does not say
 * whether the meaning survives.
 */
export const REFINE_LABEL: Record<RefineDirection, string> = {
  shorter: 'Короче',
  longer: 'Длиннее'
}

export const REFINE_HINT: Record<RefineDirection, string> = {
  shorter: 'Сократить ответ, сохранив суть',
  longer: 'Развернуть ответ подробнее'
}
