/**
 * The card's widths, in points.
 *
 * These numbers have to agree in two processes, and they did not have a single
 * source before: `main/windows/index.ts` sized the window with them, and
 * `renderer/overlay/App.tsx` used the same three values to decide where a line
 * wraps and how wide a card to ask for. When they drift the card is either
 * clipped or jumps on the first keystroke, and nothing throws — it just looks
 * wrong on screen.
 *
 * Height and the placement gap stay in `main/windows/index.ts`: the renderer
 * never needs them, and moving them here would be a shared module growing for
 * one caller.
 */

/**
 * Folded — which is how the card opens: a small pill wide enough for the resting
 * placeholder and the two trailing controls.
 *
 * It used to be 112, which was exactly the empty field plus a chevron. The card
 * now also carries a close button and asks «Что сделать?», so the narrow width has
 * to cover both without clipping the only label an empty card has.
 */
export const CARD_NARROW_WIDTH = 152

/**
 * macOS can composite a transparent window as an opaque rectangle when both
 * dimensions are under 80 points. Keep even the shortest card wide enough.
 */
export const CARD_MIN_WIDTH = 80

/** The voice bars use the smallest transparent window. */
export const CARD_VOICE_WIDTH = CARD_MIN_WIDTH

/**
 * The widest an ordinary card gets. It widens to this only when content actually
 * needs the room. A table or a code block may open wider through
 * `STRUCTURED_WIDTH` in `cardLayout.ts` without becoming a user-sized panel.
 */
export const CARD_WIDTH = 360

/**
 * How wide the card may become when the *user* asks for it.
 *
 * Content never reaches for this number: a reply that sizes itself is capped at
 * `CARD_WIDTH`, because a card that opens as wide as its longest line is a
 * panel parked over the document. A person who drags the edge has made a
 * different kind of decision — they are reading a table, and 360 points is four
 * columns of nothing.
 *
 * 720 is where a card stops being a card and becomes a window: past it the
 * cursor card is wider than most editor panes. It is a ceiling on purpose and
 * not the whole story — `userWidthCeiling` takes the smaller of this and the
 * display, so on a small screen the display wins.
 */
export const CARD_MAX_WIDTH = 720
