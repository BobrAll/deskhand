/**
 * The `@point` protocol: how the model asks to draw on the screen.
 *
 * Text answers are streamed straight to the card, and a model that streams JSON
 * cannot produce valid JSON until the very last byte. A line-based protocol can
 * instead be consumed incrementally: every complete line is either ordinary
 * answer text or a drawing instruction, and a half-received line simply waits
 * for its newline. That is why the model is asked for
 *
 *     @point arrow 0.50 0.80 0.82 0.11 «Сюда»
 *
 * and not for a JSON blob.
 *
 * Grammar (tolerant on purpose — models drift):
 *
 *     @point <kind> <x1> <y1> <x2> <y2> [label...]
 *
 * `kind` is one of circle | box | arrow | underline; the label is whatever
 * follows and may be wrapped in «», "", '' or ().
 *
 * This module has no Electron or Node dependencies so it can be tested directly.
 */

import type { Annotation, AnnotationKind, Point01 } from '@shared/types'

const KINDS: AnnotationKind[] = ['circle', 'box', 'arrow', 'underline']

/** The markers that open a drawing line; `@point` and `@draw` are the generic ones. */
const MARKERS = ['point', 'draw', ...KINDS]

const MARKER = new RegExp(`^@(?:${MARKERS.join('|')})\\b`, 'i')

/** `@` followed by the word the model is typing, so it can be matched against `MARKERS`. */
const MARKER_NAME = /^@([A-Za-z]*)/

/**
 * The smallest extent, in 0–1 units, that a drawing can have and still be meant.
 *
 * A shape below this in *both* axes is a point rather than a drawing: the model
 * wrote one coordinate and meant to point at it. A circle survives that — a
 * default size is added later — while an arrow, an underline or a box with no
 * length is dropped, because there is nothing to draw and nothing was meant.
 */
const MIN_SIDE = 0.004

/** Above this a coordinate is a percentage written by accident (50, 80), not 0–1. */
const PERCENT_COORDINATE = 1.5

/** The side of the default circle when the model gave a single point. */
const DEFAULT_SIDE = 0.03

/** A box covering more than this share of either axis is a hallucination. */
const MAX_BOX_SHARE = 0.95

const MAX_LABEL = 90

export interface ParsedLine {
  /** Shapes the line asked for (usually none). */
  annotations: Annotation[]
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(1, Math.max(0, value))
}

/**
 * One coordinate in 0–1 units.
 *
 * A value above the percentage threshold is a coordinate the model wrote as 50
 * instead of 0.5, so it is divided by a hundred; whatever is left is clamped into
 * the image, because every consumer expects 0–1.
 */
function coordinate(value: number): number {
  return clamp01(Math.abs(value) > PERCENT_COORDINATE ? value / 100 : value)
}

/**
 * Splits the part after the marker into tokens.
 *
 * The only comma that does not separate values is the decimal comma between two
 * digits ("0,5"); it belongs to the number unless the number already has a
 * decimal point ("0.5,0.8"). That is what makes the spaced form with trailing
 * commas ("arrow, 0.5, 0.8"), the compact list ("0.5,0.8,0.3,0.4") and the
 * decimal comma read as the same line.
 */
function markerTokens(rest: string): string[] {
  const tokens: string[] = []
  let token = ''
  for (let index = 0; index < rest.length; index += 1) {
    const char = rest[index]
    if (char === ',' && isDecimalComma(rest, index, token)) {
      token += '.'
    } else if (/[\s;,]/.test(char)) {
      tokens.push(token)
      token = ''
    } else {
      token += char
    }
  }
  tokens.push(token)
  return tokens.filter(Boolean)
}

/** Whether the comma at `index` is the decimal comma inside the token so far. */
function isDecimalComma(rest: string, index: number, token: string): boolean {
  const digitBefore = /\d/.test(rest[index - 1] ?? '')
  const digitAfter = /\d/.test(rest[index + 1] ?? '')
  return digitBefore && digitAfter && !token.includes('.')
}

function cleanLabel(raw: string): string | undefined {
  const label = raw
    .trim()
    // Models like to wrap the caption: «…», "…", '…', (…) — strip one layer.
    .replace(/^[«"'(\[]+/, '')
    .replace(/[»"')\]]+$/, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!label) return undefined
  return label.length > MAX_LABEL ? `${label.slice(0, MAX_LABEL - 1)}…` : label
}

/**
 * Whether `text` could still grow into a drawing marker once more characters
 * arrive.
 *
 * The stream parser needs this to decide what to hold back: `@po` may become
 * `@point` two deltas later, while `@username` is ordinary text from its first
 * character. The test is on the word after the `@`, so the answer does not
 * depend on where the network cut the chunk.
 */
export function couldStartMarker(text: string): boolean {
  const match = MARKER_NAME.exec(text)
  if (!match) return false
  const name = match[1].toLowerCase()
  return MARKERS.some((marker) => marker.startsWith(name))
}

/**
 * Parses one line. Returns `null` when the line is not protocol syntax at all,
 * and an empty `annotations` list when it looked like protocol syntax but could
 * not be used (garbage coordinates) — the caller then drops the line instead of
 * printing `@point …` into the answer.
 */
export function parseAnnotationLine(line: string): ParsedLine | null {
  const trimmed = line.trim()
  if (!MARKER.test(trimmed)) return null

  // Everything after the leading marker, as the model may write it: spaced, with
  // commas between values, compact, or with a decimal comma.
  const rest = trimmed.replace(/^@[A-Za-z]+\s*/, '')
  const tokens = markerTokens(rest)

  let kind: AnnotationKind = 'circle'
  let index = 0
  const first = tokens[0]?.toLowerCase()
  if (first && (KINDS as string[]).includes(first)) {
    kind = first as AnnotationKind
    index = 1
  }

  const numbers: number[] = []
  while (index < tokens.length && numbers.length < 4) {
    const value = Number.parseFloat(tokens[index])
    if (!Number.isFinite(value)) break
    numbers.push(value)
    index += 1
  }

  const label = cleanLabel(tokens.slice(index).join(' '))

  if (numbers.length < 2) {
    // A marker we recognised but cannot use: swallow it, draw nothing.
    return { annotations: [] }
  }

  // Two numbers describe a circle centre plus a default radius; four describe a
  // full start→end pair. Coordinates may be given as percentages by accident.
  const x1 = coordinate(numbers[0])
  const y1 = coordinate(numbers[1])
  const x2 = numbers.length >= 4 ? coordinate(numbers[2]) : clamp01(x1 + DEFAULT_SIDE)
  const y2 = numbers.length >= 4 ? coordinate(numbers[3]) : clamp01(y1 + DEFAULT_SIDE)

  const from: Point01 = { x: x1, y: y1 }
  const to: Point01 = { x: x2, y: y2 }

  const degenerate = Math.abs(to.x - from.x) < MIN_SIDE && Math.abs(to.y - from.y) < MIN_SIDE
  // A single point is fine for a circle (a default radius is added later); for
  // everything else a zero-length shape means the model had no idea.
  if (degenerate && kind !== 'circle') return { annotations: [] }

  return { annotations: [{ kind, from, to, label }] }
}

/**
 * Drops annotations that cannot be drawn sensibly.
 *
 * Models are unreliable with coordinates: a shape covering a third of the screen
 * is almost always a hallucination, and one that is completely outside the image
 * is never useful. Better to show no drawing than a confident wrong one.
 */
export function isDrawable(annotation: Annotation): boolean {
  const { from, to, kind } = annotation
  const inside = [from, to].every((point) => point.x >= 0 && point.x <= 1 && point.y >= 0 && point.y <= 1)
  if (!inside) return false
  const width = Math.abs(to.x - from.x)
  const height = Math.abs(to.y - from.y)
  // A line needs some length in either direction; a box needs both.
  if (kind !== 'box') return width + height > MIN_SIDE
  // Boxes: reject ones that swallow most of the screen.
  return width > MIN_SIDE && height > MIN_SIDE && width < MAX_BOX_SHARE && height < MAX_BOX_SHARE
}
