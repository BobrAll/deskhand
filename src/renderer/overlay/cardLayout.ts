/**
 * How wide the card opens, as a decision rather than as an expression in a render.
 *
 * Four things want room at once — the question, the answer, the answer's action
 * strip and the agent row — and the card is as wide as the widest of them, up to
 * `CARD_WIDTH`. The numbers are measured in the font each of those lines is
 * actually drawn in, so a card that widens by a different step than the typing
 * reads as a glitch instead of as the card making room.
 *
 * This used to be nine locals in the middle of `App`'s render: the arithmetic was
 * the same every frame, but the only way to check a clamp or a rounding order was
 * to open the card and look at it. Only the decision moved; the element that is
 * measured and the element that is styled stay in `App`.
 */

import { CARD_NARROW_WIDTH, CARD_WIDTH } from '@shared/metrics'
import {
  ACTIONS_CHROME,
  ACTIONS_FONT,
  AGENT_FONT,
  AGENT_ROW_CHROME,
  AGENT_STATUS_INSET,
  ANSWER_CHROME,
  CARET_SLACK,
  CHROME_WIDTH,
  STOP_CHROME,
  clamp
} from './cardMetrics'
import { resolveWidth } from './cardWidth'

/** One measuring context for the whole window: creating one is not free. */
let ruler: CanvasRenderingContext2D | null = null

/**
 * The width of the widest line of `text`, in the font the field renders in.
 *
 * Measured, never guessed from the character count: «ш» and «i» are not the same
 * letter, and a card that widens by a different step than the typing does reads
 * as a glitch rather than as the card making room. A canvas 2D context is the
 * cheapest shaper that agrees with the textarea — no extra element whose layout
 * could lag the keystroke being measured.
 */
function measureLine(text: string, font: string): number {
  if (!text) return 0
  if (!ruler) ruler = document.createElement('canvas').getContext('2d')
  if (!ruler) return 0
  if (ruler.font !== font) ruler.font = font
  let widest = 0
  // Only an explicit newline is another row; a soft wrap is a consequence of the
  // width this measurement is about to decide and must not feed back into it.
  for (const line of text.split('\n')) {
    widest = Math.max(widest, ruler.measureText(line).width)
  }
  return widest
}

/** Everything the width of the card depends on. */
export interface CardLayoutInput {
  /** The question as it stands in the field; empty while it is. */
  prompt: string
  /** The field's font, as resolved from the live element. */
  font: string
  /** The answer on screen. */
  answer: string
  /** There is real text in the answer — whitespace is not an answer. */
  hasAnswer: boolean
  /** A request is in flight, so the stop button is on the line too. */
  busy: boolean
  /** Manual playback is running, so the strip's label is the longer one. */
  speaking: boolean
  /** The agent row's status line, when it has one. */
  agentStatus: string | null
  /** The stop hint beside a running agent's status, when it is shown. */
  agentHint: string | null
  /** The status is drawn while the run is still going, without the row's inset. */
  agentRunning: boolean
  /** A voice turn shows the bars and nothing else. */
  listening: boolean
  /** The drawer, a failure or a waiting row needs the full width. */
  wantsWide: boolean
  /** The width the person dragged, or `null` while the card sizes itself. */
  userWidth: number | null
  /** The display's available width, in points. */
  availWidth: number
}

export interface CardLayout {
  /** The width the card actually takes, in points. */
  width: number
  /** The question wants more room than the card has, so it wraps. */
  wrapped: boolean
  /**
   * What the content would like, before any of the content caps.
   *
   * Kept unclamped because «Шире» has to know how much room the answer actually
   * wants: the capped number is always `CARD_WIDTH` once the answer is long, and
   * a button that opens the card to the same width for every long reply is the
   * bug it was reported as.
   */
  naturalWidth: number
}

/**
 * Composes the card's width from its measured content.
 *
 * The order is the load-bearing part: the question's chrome is added before the
 * narrow clamp, every content width is compared before the wide clamp, and the
 * user's own number is decided last by `resolveWidth`. Rounded once per width and
 * used for both decisions — how wide the card opens and whether the question
 * wraps — because two roundings of the same measurement disagree at the boundary:
 * a line that exactly fills the card would wrap while the width said it fits.
 */
export function layoutCard(input: CardLayoutInput): CardLayout {
  const textWidth = input.prompt ? measureLine(input.prompt, input.font) : 0
  /** Everything on the line that is not the question, in points. */
  const chromeWidth = CHROME_WIDTH + (input.busy ? STOP_CHROME : 0)

  /**
   * The line the field wants, in whole points. Nothing is added for empty space:
   * the field gets as many points as the sentence takes, so every keystroke
   * widens the card by exactly one glyph.
   */
  const wantedLineWidth = Math.ceil(textWidth) + chromeWidth + CARET_SLACK
  const composedWidth = clamp(wantedLineWidth, CARD_NARROW_WIDTH, CARD_WIDTH)

  const answerWidth = input.hasAnswer
    ? Math.ceil(measureLine(input.answer, input.font)) + ANSWER_CHROME + CARET_SLACK
    : 0
  const actionsWidth = input.hasAnswer
    ? Math.ceil(measureLine(
        // The widest the strip can get, measured once so the card does not grow
        // when the answer finishes and the remaining buttons appear. «Вернуть» is
        // the longer of the two width labels, so it is the one measured.
        `${input.speaking ? 'Остановить озвучку' : 'Прослушать'} Вернуть Скопировать`,
        ACTIONS_FONT
      )) + ACTIONS_CHROME
    : 0
  const agentLine = [input.agentStatus, input.agentHint].filter(Boolean).join('  ')
  const agentWidth = agentLine
    ? Math.ceil(measureLine(agentLine, AGENT_FONT)) +
      AGENT_ROW_CHROME + (input.agentRunning ? 0 : AGENT_STATUS_INSET) + CARET_SLACK
    : 0

  const inputWidth = input.agentRunning ? CARD_NARROW_WIDTH : composedWidth
  const naturalWidth = Math.max(inputWidth, answerWidth, actionsWidth, agentWidth)
  const contentWidth = clamp(naturalWidth, CARD_NARROW_WIDTH, CARD_WIDTH)
  const width = resolveWidth({
    showingVoiceBars: input.listening,
    wantsWide: input.wantsWide,
    contentWidth,
    userWidth: input.userWidth,
    availWidth: input.availWidth
  })

  return { width, wrapped: wantedLineWidth > width, naturalWidth }
}
