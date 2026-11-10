/**
 * The bubble's widths, in points.
 *
 * These numbers have to agree in two processes, and they did not have a single
 * source before: `main/windows.ts` sized the window with them, and
 * `renderer/overlay/App.tsx` used the same three values to decide where a line
 * wraps and how wide a card to ask for. When they drift the card is either
 * clipped or jumps on the first keystroke, and nothing throws — it just looks
 * wrong on screen.
 *
 * Height and the placement gap stay in `main/windows.ts`: the renderer never
 * needs them, and moving them here would be a shared module growing for one
 * caller.
 */

/**
 * Folded — which is how the card opens: a small pill about three times as wide
 * as the single line it is tall.
 */
export const BUBBLE_NARROW_WIDTH = 112

/**
 * The floor for the width. A voice turn shows nothing but a few bars, and the
 * window shrinks to fit them so the animation sits right next to the pointer
 * instead of in the middle of an invisible 112 pt strip.
 */
export const BUBBLE_MIN_WIDTH = 44

/**
 * Width of the voice surface — the bars, and nothing else.
 *
 * 80 is not a design number, it is a macOS floor: a *transparent* window smaller
 * than 80 points on both sides is composited as an opaque white rectangle, no
 * matter what `transparent`, `backgroundColor`, `hasShadow` or `vibrancy` say. The
 * bars only need 44, but at 44×33 the window showed up as a white card behind
 * them — that was the "фон" that could not be styled away from CSS, because it was
 * never the page: it was the window. With one side at 80 the window is genuinely
 * transparent and the extra space is invisible.
 */
export const BUBBLE_VOICE_WIDTH = 80

/**
 * The widest the card gets, whether it is a question or an answer inside it. It
 * widens to this only when content actually needs the room.
 */
export const BUBBLE_WIDTH = 360

/**
 * How wide the card may become when the *user* asks for it.
 *
 * Content never reaches for this number: a reply that sizes itself is capped at
 * `BUBBLE_WIDTH`, because a card that opens as wide as its longest line is a
 * panel parked over the document. A person who drags the edge has made a
 * different kind of decision — they are reading a table, and 360 points is four
 * columns of nothing.
 *
 * 720 is where a card stops being a card and becomes a window: past it the
 * cursor bubble is wider than most editor panes. It is a ceiling on purpose and
 * not the whole story — `manualCeiling` takes the smaller of this and the
 * display, so on a small screen the display wins.
 */
export const BUBBLE_MAX_WIDTH = 720
