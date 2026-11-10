/**
 * How wide the card is.
 *
 * The cases that matter are the two that fight: content asks for a number and
 * the user has already given one. A card that shrank back to its content the
 * moment the answer reflowed would undo a drag under the hand that made it.
 */

import { describe, expect, it } from 'vitest'
import { BUBBLE_MAX_WIDTH } from '@shared/metrics'
import { FULL_WIDTH, NARROW_WIDTH, VOICE_WIDTH } from './metrics'
import { draggedWidth, expandedWidth, manualCeiling, resolveWidth } from './cardWidth'

const SCREEN = 1440

function width(overrides: Partial<Parameters<typeof resolveWidth>[0]> = {}): number {
  return resolveWidth({
    listening: false,
    wantsWide: false,
    contentWidth: 200,
    userWidth: null,
    availWidth: SCREEN,
    ...overrides
  })
}

describe('resolveWidth: content', () => {
  it('takes what the content asks for', () => {
    expect(width({ contentWidth: 200 })).toBe(200)
  })

  it('never opens narrower than the pill or wider than the content cap', () => {
    expect(width({ contentWidth: 20 })).toBe(NARROW_WIDTH)
    expect(width({ contentWidth: 2000 })).toBe(FULL_WIDTH)
  })

  it('gives the drawer the full width', () => {
    expect(width({ wantsWide: true, contentWidth: 120 })).toBe(FULL_WIDTH)
  })
})

describe('resolveWidth: the user', () => {
  it('lets a chosen width beat the content', () => {
    expect(width({ userWidth: 500, contentWidth: 120 })).toBe(500)
  })

  it('lets the drawer open a card the user made narrow, and not the other way', () => {
    // The drawer's buttons need the full width; a card dragged down to 200 would
    // clip them. A card the user made wider is already roomy enough.
    expect(width({ userWidth: 200, wantsWide: true })).toBe(FULL_WIDTH)
    expect(width({ userWidth: 500, wantsWide: true })).toBe(500)
  })

  it('keeps the chosen width when the content gets shorter', () => {
    const chosen = width({ userWidth: 500, contentWidth: 300 })
    expect(width({ userWidth: chosen, contentWidth: 120 })).toBe(500)
  })

  it('clamps to the display, not just to the design ceiling', () => {
    expect(width({ userWidth: 900, availWidth: 500 })).toBe(500 - 16)
    expect(width({ userWidth: 900, availWidth: SCREEN })).toBe(BUBBLE_MAX_WIDTH)
  })

  it('never lets a voice turn be widened', () => {
    expect(width({ listening: true, userWidth: 500 })).toBe(VOICE_WIDTH)
  })
})

describe('manualCeiling', () => {
  it('is the design ceiling on a wide display', () => {
    expect(manualCeiling(SCREEN)).toBe(BUBBLE_MAX_WIDTH)
  })

  it('never falls below the content cap on a narrow one', () => {
    expect(manualCeiling(320)).toBe(FULL_WIDTH)
  })
})

describe('draggedWidth', () => {
  it('follows the pointer from where the drag started', () => {
    expect(draggedWidth(360, 120, SCREEN)).toBe(480)
    expect(draggedWidth(360, -120, SCREEN)).toBe(240)
  })

  it('stops at the display and at the floor', () => {
    expect(draggedWidth(360, 900, SCREEN)).toBe(BUBBLE_MAX_WIDTH)
    expect(draggedWidth(360, -900, SCREEN)).toBe(44)
  })

  it('rounds, because a window is sized in whole points', () => {
    expect(draggedWidth(360, 10.6, SCREEN)).toBe(371)
  })

  it('respects a floor above the window minimum', () => {
    // An unfolded drawer cannot be narrower than the full width; a drag that
    // ignored it would snap back the moment the pointer came up.
    expect(draggedWidth(360, -200, SCREEN, FULL_WIDTH)).toBe(FULL_WIDTH)
  })
})

describe('expandedWidth: what «Шире» opens to', () => {
  it('opens to the width the content asked for, not to the ceiling', () => {
    expect(expandedWidth(430, SCREEN)).toBe(430)
  })

  it('stops at the ceiling when the content wants more', () => {
    expect(expandedWidth(4000, SCREEN)).toBe(BUBBLE_MAX_WIDTH)
  })

  it('has nothing to offer when the content already fits', () => {
    expect(expandedWidth(FULL_WIDTH, SCREEN)).toBeNull()
    expect(expandedWidth(120, SCREEN)).toBeNull()
  })

  it('never opens narrower than the full width', () => {
    expect(expandedWidth(FULL_WIDTH + 0.4, SCREEN)).toBe(FULL_WIDTH)
  })
})
