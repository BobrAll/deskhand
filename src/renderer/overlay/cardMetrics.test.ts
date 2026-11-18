/**
 * The card's numbers, pinned.
 *
 * Two things are worth a test here and neither is arithmetic:
 *
 * 1. The widths are *not* written out in the renderer. They come from
 *    `@shared/metrics` because the main process clamps the window to the very
 *    same points — a local copy is how the card ends up clipped or jumping, and
 *    nothing throws when it does. This module re-exports none of them: every use
 *    site imports the `CARD_*` names directly.
 * 2. The chrome numbers describe the CSS, so they are checked against it. They
 *    cannot be imported from the stylesheet, and a hand-summed number that has
 *    drifted from the rule it describes is exactly how the chevron ends up
 *    sitting on the last letter: nothing throws, it just looks wrong.
 */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  ACTIONS_FONT,
  CARET_SLACK,
  CHROME_WIDTH,
  FIELD_FONT,
  MAX_FIELD_HEIGHT,
  STOP_CHROME,
  clamp
} from './cardMetrics'

const overlayCss = readFileSync(join(__dirname, 'overlay.css'), 'utf8')

/** The declarations of one rule, so a property can be read from the rule it belongs to. */
function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(overlayCss)
  expect(match, `overlay.css must still declare ${selector}`).not.toBeNull()
  return match?.[1] ?? ''
}

function px(block: string, property: string): number {
  const match = new RegExp(`(?:^|\\n)\\s*${property}:\\s*(\\d+)px`).exec(block)
  expect(match, `${property} must still be declared in px`).not.toBeNull()
  return Number(match?.[1])
}

describe('metrics: the widths stay in @shared/metrics', () => {
  const read = (name: string): string => readFileSync(join(__dirname, name), 'utf8')

  // The width literals themselves are guarded once, in `@shared/metrics.test.ts`,
  // where all four files that could carry a copy are checked together. What is
  // worth checking here is that this module adds none of its own.
  it('does not re-export the widths under local names', () => {
    const source = read('cardMetrics.ts')

    expect(source).not.toMatch(/export const (NARROW_WIDTH|VOICE_WIDTH|FULL_WIDTH)\b/)
  })
})

describe('metrics: the chrome the CSS spends', () => {
  it('sums the padding, the edge, the chevron and the close button', () => {
    const card = rule('.card')
    const padding = /(?:^|\n)\s*padding:\s*(\d+)px\s+(\d+)px/.exec(card)
    expect(padding, '.card must still declare "padding: <vertical>px <horizontal>px"').not.toBeNull()
    const horizontalPadding = Number(padding?.[2])
    const edge = px(card, 'border') * 2
    const gap = px(rule('.line'), 'gap')
    const chevron = px(rule('button.toggle'), 'width')
    const close = px(rule('button.close'), 'width')

    expect(CHROME_WIDTH).toBe(horizontalPadding * 2 + edge + gap + chevron + gap + close)
  })

  it('counts the stop button and its gap', () => {
    expect(STOP_CHROME).toBe(px(rule('button.stop'), 'width') + px(rule('.line'), 'gap'))
  })

  it('leaves room for the caret and for a lost sub-pixel', () => {
    expect(CARET_SLACK).toBe(4)
  })

  it('caps the field at the height overlay.css actually clips it to', () => {
    const css = readFileSync(join(__dirname, 'overlay.css'), 'utf8')
    const match = /textarea\.prompt\s*{[^}]*max-height:\s*(\d+)px/.exec(css)

    expect(match, 'overlay.css must still declare max-height on textarea.prompt').not.toBeNull()
    expect(MAX_FIELD_HEIGHT).toBe(Number(match?.[1]))
  })

  it('names the same font and size the stylesheet renders the field in', () => {
    const css = readFileSync(join(__dirname, 'overlay.css'), 'utf8')
    const base = readFileSync(join(__dirname, '../styles/base.css'), 'utf8')
    const size = /textarea\.prompt\s*{[^}]*font-size:\s*(\d+)px/.exec(css)
    const family = /--font:\s*([^;]+);/.exec(base)

    expect(size?.[1], 'textarea.prompt must still declare a font-size').toBeDefined()
    expect(family?.[1], '--font must still be declared').toBeDefined()
    expect(FIELD_FONT.startsWith(`${size?.[1]}px `)).toBe(true)
    // The same family, in the same order: the measurement has to shape the run
    // exactly as the textarea will, or the card widens by the wrong step.
    expect(FIELD_FONT).toBe(`${size?.[1]}px ${family?.[1]?.trim()}`)
  })

  it('measures the action strip in the size the links are rendered in', () => {
    const css = readFileSync(join(__dirname, 'overlay.css'), 'utf8')
    const size = /button\.link\s*{[^}]*font-size:\s*([\d.]+)px/.exec(css)

    expect(size?.[1], 'button.link must still declare a font-size').toBeDefined()
    expect(ACTIONS_FONT.startsWith(`${size?.[1]}px `)).toBe(true)
  })
})

describe('metrics: clamp', () => {
  it('keeps a value inside the range', () => {
    expect(clamp(5, 0, 10)).toBe(5)
    expect(clamp(-1, 0, 10)).toBe(0)
    expect(clamp(11, 0, 10)).toBe(10)
  })
})
