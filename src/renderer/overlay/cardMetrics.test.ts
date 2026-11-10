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
 * 2. The chrome numbers describe the CSS. They cannot be derived from it (the
 *    renderer has no stylesheet parser and the values are hand-summed from
 *    `overlay.css`), so they are pinned instead: changing one is a deliberate act
 *    that has to show up in a diff, not a typo that silently moves the chevron.
 */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  CARET_SLACK,
  CHROME_WIDTH,
  FIELD_FONT,
  MAX_FIELD_HEIGHT,
  STOP_CHROME,
  clamp
} from './cardMetrics'

describe('metrics: the widths stay in @shared/metrics', () => {
  const read = (name: string): string => readFileSync(join(__dirname, name), 'utf8')

  it('does not re-export the widths under local names', () => {
    const source = read('cardMetrics.ts')

    expect(source).not.toMatch(/export const (NARROW_WIDTH|VOICE_WIDTH|FULL_WIDTH)\b/)
  })

  it('does not repeat the literals in this module', () => {
    const source = read('cardMetrics.ts')

    expect(source).not.toMatch(/=\s*360\b/)
    expect(source).not.toMatch(/=\s*112\b/)
    expect(source).not.toMatch(/=\s*80\b/)
  })

  it('is what the card lays itself out with', () => {
    // The two files that size the card import the shared names; neither may
    // carry a copy of a width.
    for (const name of ['cardWidth.ts', 'App.tsx']) {
      const source = read(name)
      expect(source, name).toMatch(/CARD_(WIDTH|NARROW_WIDTH|VOICE_WIDTH)/)
      expect(source, name).not.toMatch(/=\s*360\b/)
      expect(source, name).not.toMatch(/=\s*112\b/)
      expect(source, name).not.toMatch(/=\s*80\b/)
    }
  })
})

describe('metrics: the chrome the CSS spends', () => {
  it('sums the padding, the edge, the gap and the chevron', () => {
    // 8px padding on both sides + 2px edge + 6 gap + 16 chevron.
    expect(CHROME_WIDTH).toBe(40)
  })

  it('counts the stop button and its gap', () => {
    expect(STOP_CHROME).toBe(24)
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
})

describe('metrics: clamp', () => {
  it('keeps a value inside the range', () => {
    expect(clamp(5, 0, 10)).toBe(5)
    expect(clamp(-1, 0, 10)).toBe(0)
    expect(clamp(11, 0, 10)).toBe(10)
  })
})
