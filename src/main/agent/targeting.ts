/**
 * Where a click actually goes.
 *
 * The model returns a point in the picture; this module turns it into a point on
 * the screen. Normally that would be one multiply — but the point is only a guess
 * about *which control* the model meant, and twenty to sixty points of error is
 * the norm for a language model looking at a downscaled screenshot. On a 24-point
 * toolbar icon that is not a near miss, it is the neighbouring button.
 *
 * The screen has the exact answer. The Accessibility API reports the real
 * rectangle of every button, field and menu item, so the model's point is used for
 * what it is good at — picking the region — and the rectangle supplies the pixel.
 * Four ways to make that trade, in order of how much evidence they rest on:
 *
 * 1. **Label.** The model writes «Экспорт» on the `@click` line. If an actionable
 *    element with that text exists near the point, its centre is the target. This
 *    is the strongest signal, because it survives a point that missed by a mile.
 * 2. **Containment.** No label match, but the point is inside an actionable
 *    element: the click stays where the model aimed, only pulled inside the
 *    edges. A static text inside a button resolves to the button, because the
 *    *smallest* container wins.
 * 3. **Snap.** No containment, but a control sits within a few dozen points of
 *    the guess. This is the case that used to fall through to the model's raw
 *    pixel — the model aimed 30 points left of an icon and the click landed in
 *    the gap — and it is why the agent "did not do anything" on a plan it had
 *    described correctly. A visible name that contradicts the label still stops
 *    the snap: "Экспорт" becoming "Удалить" is the failure this rule exists to
 *    prevent.
 * 4. **Model.** Nothing matched: the model's own point is used, and `confidence`
 *    says so, so the card can be honest about a click that is a guess.
 *
 * A click that is *inferred* (rules 1 and 3) goes to the centre of the rectangle,
 * because the model never landed inside it: the centre is the only part of a
 * control that is guaranteed to be the control. A click that is *contained*
 * (rule 2) keeps the model's aim, because the point is already on the element and
 * the centre of a wide row or a text field is a worse place than where the model
 * pointed.
 *
 * Pure module: no Electron, no Node, no I/O. Everything here is arithmetic on
 * rectangles and strings, so it can be reasoned about (and tested) on its own.
 */

import type { AxElementInfo, AxProbe, ScreenRect } from '@shared/types'

/** A point in global screen points, top-left origin. */
export interface ScreenPoint {
  x: number
  y: number
}

type TargetSource =
  /** The point landed inside a clickable element; its rectangle keeps the aim. */
  | 'point'
  /** An element with the model's label was found; its centre is used. */
  | 'label'
  /** A control next to the point was assumed to be the target; its centre is used. */
  | 'snap'
  /** Nothing on the screen matched: the model's own point is used. */
  | 'model'

export interface TargetResolution {
  point: ScreenPoint
  /** The element the point was snapped to, or null when nothing was found. */
  element: AxElementInfo | null
  source: TargetSource
  /** How far the click moved away from the model's point, in points. */
  shift: number
  /** 0..1. Below ~0.5 the click is a guess and the card should not oversell it. */
  confidence: number
  /**
   * Set when the point sits inside a control whose visible name contradicts the
   * label — in a dense list, the row next door. The caller must not click it:
   * the name is the only thing on screen that can say "this is not what you
   * meant", and the cost of being wrong here is a different pane, tab or page.
   */
  conflict?: string | null
}

export interface ResolveInput {
  /** The model's point, already mapped to screen points. */
  rough: ScreenPoint
  /** The `«…»` part of the `@click` line, if the model wrote one. */
  label?: string | null
  /** What the Accessibility API reported; null when it could not answer. */
  probe: AxProbe | null
  /** The rectangle the screenshot covered: the only place a click may land. */
  area: ScreenRect
}

/**
 * How similar a label has to be to an element's text to be trusted far away.
 *
 * Deliberately strict. A label match moves the click away from where the model
 * pointed, so it has to be worth the move: "Отмена" versus "Отменить" is 0.71 and
 * is rejected here, because the point is already a better witness than a
 * similarity that close.
 */
const LABEL_FLOOR = 0.75

/**
 * How similar it has to be when the element is next to the point.
 *
 * Lower, because the two signals then confirm each other: a control 20 points
 * from the guess whose name is recognisably the label is the target even when the
 * wording drifted ("Сохранить" written for "Сохранить как"). A paraphrase far
 * from the point is how a click jumps across the window, so this floor only
 * applies inside the snap radius.
 */
const WEAK_LABEL_FLOOR = 0.55

/**
 * Below this, an element's visible name *contradicts* the label.
 *
 * "«Экспорт» becoming «Удалить»" is the action this module exists to prevent: a
 * nearby control with an unrelated name is a different control, and a miss is
 * cheaper than a wrong destructive click.
 */
const CONTRADICTION = 0.35

/** Elements covering this share of the frame are containers, not targets. */
const CONTAINER_SHARE = 0.35

/**
 * How far from the point an inferred target may sit, as a share of the frame's
 * diagonal. The model is wrong by 20–60 points on a downscaled 1470-point
 * screenshot; 5 % of the diagonal is ~87 points, which covers that with margin
 * without reaching across a window.
 */
const SNAP_SHARE = 0.05
const SNAP_MIN = 48
const SNAP_MAX = 160

/**
 * An inferred target must be control-sized. A 600×300 panel a few points from the
 * guess is the background, not the thing the model meant, and clicking its centre
 * would be a click in the middle of nowhere.
 */
const SNAP_MAX_WIDTH = 360
const SNAP_MAX_HEIGHT = 240

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

export function centerOf(rect: ScreenRect): ScreenPoint {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
}

function rectArea(rect: ScreenRect): number {
  return Math.max(0, rect.width) * Math.max(0, rect.height)
}

function containsPoint(rect: ScreenRect, point: ScreenPoint, margin = 0): boolean {
  return (
    point.x >= rect.x - margin &&
    point.x <= rect.x + rect.width + margin &&
    point.y >= rect.y - margin &&
    point.y <= rect.y + rect.height + margin
  )
}

/** Distance from a point to a rectangle; zero when the point is inside it. */
function distanceToRect(rect: ScreenRect, point: ScreenPoint): number {
  const dx = Math.max(rect.x - point.x, 0, point.x - (rect.x + rect.width))
  const dy = Math.max(rect.y - point.y, 0, point.y - (rect.y + rect.height))
  return Math.hypot(dx, dy)
}

function distanceBetween(a: ScreenPoint, b: ScreenPoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

function clampPoint(point: ScreenPoint, area: ScreenRect): ScreenPoint {
  const x = Math.min(area.x + area.width - 1, Math.max(area.x, point.x))
  const y = Math.min(area.y + area.height - 1, Math.max(area.y, point.y))
  return { x: Math.round(x), y: Math.round(y) }
}

/**
 * Whether an element is a surface rather than a control.
 *
 * Measured by *area* share, not by a single side: the old per-side test threw
 * away every wide-but-short control — a browser's address bar, a full-width
 * search field, a toolbar row — and those are exactly the targets the model
 * describes by name. A text field is never a container whatever its size,
 * because clicking it is unambiguous.
 */
function isContainer(element: AxElementInfo, area: ScreenRect): boolean {
  if (element.editable) return false
  const frame = element.frame as ScreenRect
  if (rectArea(frame) >= rectArea(area) * CONTAINER_SHARE) return true
  return frame.height >= area.height * 0.6
}

/** The radius inside which an element may be inferred from the point. */
function snapReach(area: ScreenRect): number {
  const diagonal = Math.hypot(area.width, area.height) || 1
  return Math.max(SNAP_MIN, Math.min(SNAP_MAX, diagonal * SNAP_SHARE))
}



// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

/**
 * Lowercased, punctuation-free form of a label.
 *
 * `ё` becomes `е` because a model writes whichever it likes and mac apps label
 * menus with the other one. Quotes and dashes go away so «Экспорт…» and
 * "экспорт" compare equal.
 */
export function normalizeText(raw: string | null | undefined): string {
  if (!raw) return ''
  return raw
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[\u00ab\u00bb\u2018\u2019\u201c\u201d\u0022\u0027\u0060]/g, '')
    .replace(/[.,:;!?…·•/\\|()[\]{}<>_—–-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Classic edit distance, one row of memory; labels are short, so this is cheap. */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0
  if (!a.length) return b.length
  if (!b.length) return a.length
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index)
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i]
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      current[j] = Math.min(current[j - 1] + 1, previous[j] + 1, previous[j - 1] + cost)
    }
    previous = current
  }
  return previous[b.length]
}

function commonPrefix(a: string, b: string): number {
  const limit = Math.min(a.length, b.length)
  let index = 0
  while (index < limit && a[index] === b[index]) index += 1
  return index
}

/**
 * Overlap of two names allowing for word forms.
 *
 * Russian inflects, and the same control is "Закрыть" on a button and "кнопка
 * закрытия" in the accessibility description — plain edit distance sees two
 * unrelated strings there. A shared stem of six letters is enough for
 * "закрыть/закрытия" and "сохранить/сохранение", and deliberately not enough for
 * "отмена/отменить" (five), which is the pair this must keep apart.
 */
function stemOverlap(left: string, right: string): number {
  const leftWords = left.split(' ').filter(Boolean)
  const rightWords = right.split(' ').filter(Boolean)
  if (leftWords.length === 0 || rightWords.length === 0) return 0
  let shared = 0
  for (const word of leftWords) {
    for (const other of rightWords) {
      if (word === other) {
        shared += 1
        break
      }
      const prefix = commonPrefix(word, other)
      if (prefix >= 6) {
        shared += 1
        break
      }
    }
  }
  // Scored by how much of the *label* the name covers, not by the union of both:
  // a one-word label found inside a longer accessibility name ("Закрыть" in
  // "кнопка закрытия") is a match, and averaging it against the two words of the
  // description would have called it half a match.
  const coverage = shared / leftWords.length
  const spread = shared / rightWords.length
  return Math.max(spread, coverage * 0.8)
}

/**
 * How much `candidate` looks like `label`, 0..1.
 *
 * Four ways a model's wording can differ from the real one, and all are common:
 * the label is a prefix ("Экспорт" for "Экспорт в PDF"), a loose paraphrase
 * ("Сохранить" for "Сохранить как"), the same words in another order, or another
 * inflection of the same word. Containment, word overlap, edit distance and stem
 * overlap cover them; the best of the four wins.
 */
export function textMatchScore(label: string, candidate: string): number {
  const left = normalizeText(label)
  const right = normalizeText(candidate)
  if (!left || !right) return 0
  if (left === right) return 1

  const shorter = left.length <= right.length ? left : right
  const longer = left.length <= right.length ? right : left
  // Short fragments match too easily ("ок" inside "Окно"), so containment only
  // counts when the fragment itself is a word worth matching.
  if (shorter.length >= 4 && longer.includes(shorter)) {
    return 0.65 + 0.3 * (shorter.length / longer.length)
  }

  const edit = 1 - levenshtein(left, right) / longer.length
  const leftWords = new Set(left.split(' ').filter(Boolean))
  const rightWords = new Set(right.split(' ').filter(Boolean))
  let shared = 0
  for (const word of leftWords) if (rightWords.has(word)) shared += 1
  const union = leftWords.size + rightWords.size - shared
  const overlap = union > 0 ? shared / union : 0
  return Math.max(edit, overlap, stemOverlap(left, right))
}

/**
 * Every name an element carries.
 *
 * `roleDescription` is in the list because for an icon-only button it is the
 * *only* name macOS gives: the traffic-light buttons of a window report no title
 * and no description, just "кнопка закрытия". Leaving it out meant the model's
 * «Закрыть» could never match the × it was looking at.
 *
 * `value` is not a name for a text field: it is the text *inside* it, so a model
 * that writes «поиск» for a field containing "youtube.com" would look like it was
 * contradicting the element it meant. For everything else the value is the
 * visible text of a static element and belongs in the comparison.
 */
function elementTexts(element: AxElementInfo): string[] {
  return [element.title, element.editable ? null : element.value, element.description, element.roleDescription].filter(
    (text): text is string => Boolean(text && text.trim())
  )
}

/** The best similarity between the label and any name the element carries. */
function bestTextScore(label: string, element: AxElementInfo): number {
  let best = 0
  for (const text of elementTexts(element)) {
    best = Math.max(best, textMatchScore(label, text))
  }
  return best
}

/**
 * The names the element *shows*, as opposed to the kind of control it is.
 *
 * `roleDescription` is the Accessibility API's word for the widget ("кнопка",
 * "контурный ряд"), never the thing the model named, so it can never contradict
 * a label: an icon button that only reports "кнопка" is unnamed as far as this
 * question goes, and its aim is still trusted.
 */
function nameTexts(element: AxElementInfo): string[] {
  return [element.title, element.value, element.description].filter((text): text is string =>
    Boolean(text && String(text).trim())
  )
}

// ---------------------------------------------------------------------------
// Candidates
// ---------------------------------------------------------------------------

function actionable(element: AxElementInfo): boolean {
  return element.pressable === true || element.editable === true
}

/**
 * Every element worth aiming at, with the impossible ones removed.
 *
 * Elements whose centre is outside the captured frame are dropped: the model
 * never saw them, so it cannot have meant them, and clicking one would move the
 * pointer off the display the answer was about.
 */
function candidates(probe: AxProbe | null, area: ScreenRect): AxElementInfo[] {
  if (!probe) return []
  const seen = new Set<string>()
  const result: AxElementInfo[] = []
  for (const element of [...probe.chain, ...probe.targets]) {
    const frame = element.frame
    if (!frame) continue
    if (!actionable(element)) continue
    if (frame.width < 2 || frame.height < 2) continue
    if (isContainer(element, area)) continue
    if (!containsPoint(area, centerOf(frame), 1)) continue
    const key = `${element.role}|${element.title ?? ''}|${element.value ?? ''}|${element.description ?? ''}|${Math.round(frame.x)},${Math.round(frame.y)},${Math.round(frame.width)},${Math.round(frame.height)}`
    if (seen.has(key)) continue
    seen.add(key)
    result.push(element)
  }
  return result
}

function resolution(
  element: AxElementInfo,
  source: TargetSource,
  confidence: number,
  rough: ScreenPoint,
  area: ScreenRect
): TargetResolution {
  const point = clampPoint(centerOf(element.frame as ScreenRect), area)
  return {
    point,
    element,
    source,
    shift: Math.round(distanceBetween(rough, point)),
    confidence
  }
}

/** How close the element is to the point, 0..1, scaled by the frame's size. */
function proximityScore(frame: ScreenRect, rough: ScreenPoint, area: ScreenRect): number {
  const diagonal = Math.hypot(area.width, area.height) || 1
  return 1 - Math.min(1, distanceToRect(frame, rough) / (diagonal * 0.25))
}

/**
 * Rule 1: an element whose visible name matches the label the model wrote.
 *
 * A strong name is trusted anywhere in the frame, because that is the whole
 * reason the rule exists — the label survives a point that missed by a hundred
 * points. A *weak* name is only trusted next to the point, where the two signals
 * corroborate each other.
 */
function byLabel(
  label: string,
  list: AxElementInfo[],
  rough: ScreenPoint,
  area: ScreenRect
): TargetResolution | null {
  if (normalizeText(label).length < 2) return null
  const reach = snapReach(area)
  let best: { element: AxElementInfo; score: number } | null = null
  for (const element of list) {
    const frame = element.frame as ScreenRect
    const text = bestTextScore(label, element)
    if (text < WEAK_LABEL_FLOOR) continue
    const local = distanceToRect(frame, rough) <= reach
    if (text < LABEL_FLOOR && !local) continue
    const score = text * 0.66 + proximityScore(frame, rough, area) * 0.26 + (local ? 0.08 : 0)
    if (!best || score > best.score) best = { element, score }
  }
  if (!best) return null
  return resolution(best.element, 'label', Math.min(0.98, 0.55 + best.score * 0.45), rough, area)
}

/**
 * The model's point, pulled inside an element's clickable area.
 *
 * Containment does not move the click to the centre on purpose: the point is
 * already inside the target, and the centre of a wide row or a text field is a
 * worse place than where the model aimed. Only the edges are corrected, because
 * a point two points outside a button is a miss with a very expensive kind of
 * confidence.
 */
function insetPoint(point: ScreenPoint, rect: ScreenRect): ScreenPoint {
  const inset = Math.min(3, rect.width / 4, rect.height / 4)
  const x = Math.min(rect.x + rect.width - inset, Math.max(rect.x + inset, point.x))
  const y = Math.min(rect.y + rect.height - inset, Math.max(rect.y + inset, point.y))
  return { x, y }
}

/**
 * Rule 2: the smallest clickable thing the point is already inside.
 *
 * Containment is trusted on its own, even when the element's name is nothing
 * like the label: a point inside a control is the strongest thing the model
 * produces, and a label that matches nothing on the screen (a hallucinated name,
 * a translated one) must not turn that exact aim into a click somewhere else.
 * When the label *does* match another element, the two rules disagree and
 * `resolveTarget` decides — that is the only place a name outranks an aim.
 */
function byPoint(
  list: AxElementInfo[],
  rough: ScreenPoint,
  area: ScreenRect
): TargetResolution | null {
  let best: AxElementInfo | null = null
  for (const element of list) {
    const frame = element.frame as ScreenRect
    if (!containsPoint(frame, rough, 2)) continue
    if (!best || rectArea(frame) < rectArea(best.frame as ScreenRect)) best = element
  }
  if (!best) return null
  const point = clampPoint(insetPoint(rough, best.frame as ScreenRect), area)
  return {
    point,
    element: best,
    source: 'point',
    shift: Math.round(distanceBetween(rough, point)),
    confidence: 0.7
  }
}

/** 1 when the control sits in the same row or column as the guess, else less. */
function alignmentScore(frame: ScreenRect, rough: ScreenPoint): number {
  const dx = Math.max(frame.x - rough.x, 0, rough.x - (frame.x + frame.width))
  const dy = Math.max(frame.y - rough.y, 0, rough.y - (frame.y + frame.height))
  if (dy <= 2 && dx > 0) return 1
  if (dx <= 2 && dy > 0) return 0.85
  return 0.3
}

/** Prefer things that are shaped like a control over corridors and slivers. */
function sizeScore(frame: ScreenRect): number {
  const longest = Math.max(frame.width, frame.height)
  const shortest = Math.min(frame.width, frame.height)
  if (shortest < 6) return 0.2
  if (longest <= 120) return 1
  if (longest <= 220) return 0.6
  return 0.25
}

/**
 * Rule 3: the control next to the point that the model most likely meant.
 *
 * This is the rule that turns "he aimed 30 points left of the icon" into a click
 * on the icon instead of a click in the empty gap — the failure that made the
 * assistant describe the right plan and then do nothing. Distance dominates, but
 * a control in the same row as the guess beats one on the diagonal, and a
 * control-shaped element beats a corridor. A name that contradicts the label
 * disqualifies a candidate outright.
 */
function bySnap(
  label: string | null | undefined,
  list: AxElementInfo[],
  rough: ScreenPoint,
  area: ScreenRect
): TargetResolution | null {
  const reach = snapReach(area)
  const needle = normalizeText(label)
  let best: { element: AxElementInfo; score: number; closeness: number; text: number } | null = null
  for (const element of list) {
    const frame = element.frame as ScreenRect
    if (frame.width > SNAP_MAX_WIDTH || frame.height > SNAP_MAX_HEIGHT) continue
    const gap = distanceToRect(frame, rough)
    if (gap > reach) continue
    const text = needle ? bestTextScore(label ?? '', element) : 0
    // A visible, different name is decisive: the neighbour of the named control
    // is a different control, and a miss is cheaper than a wrong click.
    if (needle && elementTexts(element).length > 0 && text < CONTRADICTION) continue
    const closeness = 1 - gap / reach
    const score =
      closeness * 0.55 + alignmentScore(frame, rough) * 0.15 + sizeScore(frame) * 0.08 + text * 0.4
    if (!best || score > best.score) best = { element, score, closeness, text }
  }
  if (!best) return null
  // An inferred target is clicked in the middle: the model never landed on it, so
  // the centre is the only part of the control that is guaranteed to be the
  // control, and an icon's edges are padding rather than the icon.
  const point = clampPoint(centerOf(best.element.frame as ScreenRect), area)
  return {
    point,
    element: best.element,
    source: 'snap',
    shift: Math.round(distanceBetween(rough, point)),
    confidence: Math.min(0.75, 0.3 + best.closeness * 0.25 + best.text * 0.2)
  }
}

/**
 * The point to click, given what the model guessed and what the screen knows.
 */
export function resolveTarget(input: ResolveInput): TargetResolution {
  const { rough, label, probe, area } = input
  const fallback: TargetResolution = {
    point: clampPoint(rough, area),
    element: null,
    source: 'model',
    shift: 0,
    confidence: 0.15
  }

  const list = candidates(probe, area)
  if (list.length === 0) return fallback

  const labelled = byLabel(label ?? '', list, rough, area)
  const contained = byPoint(list, rough, area)

  // Both rules found something, and they disagree. Containment wins unless the
  // element the point landed in is a different control *by name* and the label
  // found a strong match elsewhere: the model aims at what it names, and its aim
  // is the part that drifts.
  if (labelled && contained) {
    const same = labelled.element === contained.element
    if (same) return contained
    const agreed = bestTextScore(label ?? '', contained.element as AxElementInfo) >= WEAK_LABEL_FLOOR
    return agreed ? contained : labelled
  }
  if (labelled) return labelled
  if (contained) {
    // The point is inside a control, and the label names something else.
    //
    // In a dense list — System Settings' sidebar, a list of search results, a
    // menu — one row is 24–32 points tall and the model is routinely 20–60
    // points off, so this is exactly how "нажми «Клавиатура»" becomes a click
    // on the row above it: the pane that opens is not the one the rest of the
    // plan was written for, and every step after it lands in the wrong place.
    // An unnamed control is still trusted (there is nothing to contradict); a
    // named one that disagrees is reported instead of pressed.
    const labelText = normalizeText(label ?? '')
    if (labelText.length >= 2) {
      const names = nameTexts(contained.element as AxElementInfo)
      let best = 0
      for (const name of names) best = Math.max(best, textMatchScore(label ?? '', name))
      if (names.length > 0 && best < CONTRADICTION) {
        return { ...contained, confidence: 0.2, conflict: names[0] }
      }
    }
    return contained
  }
  return bySnap(label, list, rough, area) ?? fallback
}

/**
 * Whether the keyboard is in a text field.
 *
 * `true`/`false` when the Accessibility API answered, `null` when it did not —
 * the difference matters: an app that reports nothing must not be treated as
 * "there is no field here", or typing would stop working in it.
 */
export function isTextField(element: AxElementInfo | null | undefined): boolean | null {
  if (!element || !element.role) return null
  return element.editable === true
}
