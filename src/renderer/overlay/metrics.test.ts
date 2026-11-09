/**
 * The card's numbers, pinned.
 *
 * Two things are worth a test here and neither is arithmetic:
 *
 * 1. The three widths are *not* written out in this file. They come from
 *    `@shared/metrics` because the main process clamps the window to the very
 *    same points — a local copy is how the card ends up clipped or jumping, and
 *    nothing throws when it does.
 * 2. The chrome numbers describe the CSS. They cannot be derived from it (the
 *    renderer has no stylesheet parser and the values are hand-summed from
 *    `overlay.css`), so they are pinned instead: changing one is a deliberate act
 *    that has to show up in a diff, not a typo that silently moves the chevron.
 */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { BUBBLE_NARROW_WIDTH, BUBBLE_VOICE_WIDTH, BUBBLE_WIDTH } from '@shared/metrics'
import {
  CARET_SLACK,
  CHROME_WIDTH,
  FIELD_FONT,
  FULL_WIDTH,
  MAX_FIELD_HEIGHT,
  NARROW_WIDTH,
  REFINE_HINT,
  REFINE_LABEL,
  STOP_CHROME,
  VOICE_WIDTH,
  clamp
} from './metrics'

describe('metrics: the widths come from @shared/metrics', () => {
  it('is the same three numbers the main process clamps the window to', () => {
    expect(NARROW_WIDTH).toBe(BUBBLE_NARROW_WIDTH)
    expect(VOICE_WIDTH).toBe(BUBBLE_VOICE_WIDTH)
    expect(FULL_WIDTH).toBe(BUBBLE_WIDTH)
  })

  it('keeps the values the card was tuned with', () => {
    expect(NARROW_WIDTH).toBe(112)
    expect(VOICE_WIDTH).toBe(80)
    expect(FULL_WIDTH).toBe(360)
  })

  it('does not repeat the literals in this module', () => {
    const source = readFileSync(join(__dirname, 'metrics.ts'), 'utf8')

    expect(source).not.toMatch(/=\s*360\b/)
    expect(source).not.toMatch(/=\s*112\b/)
    expect(source).not.toMatch(/=\s*80\b/)
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

describe('metrics: the rewrite buttons', () => {
  it('labels both directions and explains them in the tooltip', () => {
    expect(REFINE_LABEL).toEqual({ shorter: 'Короче', longer: 'Длиннее' })
    expect(REFINE_HINT.shorter).toBe('Сократить ответ, сохранив суть')
    expect(REFINE_HINT.longer).toBe('Развернуть ответ подробнее')
  })
})

describe('metrics: clamp', () => {
  it('keeps a value inside the range', () => {
    expect(clamp(5, 0, 10)).toBe(5)
    expect(clamp(-1, 0, 10)).toBe(0)
    expect(clamp(11, 0, 10)).toBe(10)
  })
})
