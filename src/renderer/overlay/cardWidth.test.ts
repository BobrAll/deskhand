/**
 * How wide the card is.
 *
 * The cases that matter are the two that fight: content asks for a number and
 * the user has already given one. A card that shrank back to its content the
 * moment the answer reflowed would undo a drag under the hand that made it.
 */

import { describe, expect, it } from 'vitest'
import { CARD_MAX_WIDTH, CARD_NARROW_WIDTH, CARD_VOICE_WIDTH, CARD_WIDTH } from '@shared/metrics'
import { draggedWidth, expandedWidth, userWidthCeiling, resolveWidth } from './cardWidth'
import type { WidthInputs } from './cardWidth'
import { STRUCTURED_WIDTH } from './cardLayout'

const SCREEN = 1440

function width(overrides: Partial<WidthInputs> = {}): number {
  return resolveWidth({
    showingVoiceBars: false,
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
    expect(width({ contentWidth: 20 })).toBe(CARD_NARROW_WIDTH)
    expect(width({ contentWidth: 2000 })).toBe(CARD_WIDTH)
  })

  it('gives the drawer the full width', () => {
    expect(width({ wantsWide: true, contentWidth: 120 })).toBe(CARD_WIDTH)
  })

  it('lets structured content use its wider cap', () => {
    expect(
      width({
        contentWidth: STRUCTURED_WIDTH,
        contentMax: STRUCTURED_WIDTH
      })
    ).toBe(STRUCTURED_WIDTH)
  })
})

describe('resolveWidth: the user', () => {
  it('lets a chosen width beat the content', () => {
    expect(width({ userWidth: 500, contentWidth: 120 })).toBe(500)
  })

  it('lets the drawer open a card the user made narrow, and not the other way', () => {
    // The drawer's buttons need the full width; a card dragged down to 200 would
    // clip them. A card the user made wider is already roomy enough.
    expect(width({ userWidth: 200, wantsWide: true })).toBe(CARD_WIDTH)
    expect(width({ userWidth: 500, wantsWide: true })).toBe(500)
  })

  it('keeps the chosen width when the content gets shorter', () => {
    const chosen = width({ userWidth: 500, contentWidth: 300 })
    expect(width({ userWidth: chosen, contentWidth: 120 })).toBe(500)
  })

  it('clamps to the display, not just to the design ceiling', () => {
    expect(width({ userWidth: 900, availWidth: 500 })).toBe(500 - 16)
    expect(width({ userWidth: 900, availWidth: SCREEN })).toBe(CARD_MAX_WIDTH)
  })

  it('never lets a voice turn be widened', () => {
    expect(width({ showingVoiceBars: true, userWidth: 500 })).toBe(CARD_VOICE_WIDTH)
  })
})

describe('userWidthCeiling', () => {
  it('is the design ceiling on a wide display', () => {
    expect(userWidthCeiling(SCREEN)).toBe(CARD_MAX_WIDTH)
  })

  it('never falls below the content cap on a narrow one', () => {
    expect(userWidthCeiling(320)).toBe(CARD_WIDTH)
  })
})

describe('draggedWidth', () => {
  it('follows the pointer from where the drag started', () => {
    expect(draggedWidth(360, 120, SCREEN)).toBe(480)
    expect(draggedWidth(360, -120, SCREEN)).toBe(240)
  })

  it('stops at the display and at the floor', () => {
    expect(draggedWidth(360, 900, SCREEN)).toBe(CARD_MAX_WIDTH)
    expect(draggedWidth(360, -900, SCREEN)).toBe(80)
  })

  it('rounds, because a window is sized in whole points', () => {
    expect(draggedWidth(360, 10.6, SCREEN)).toBe(371)
  })

  it('respects a floor above the window minimum', () => {
    // An unfolded drawer cannot be narrower than the full width; a drag that
    // ignored it would snap back the moment the pointer came up.
    expect(draggedWidth(360, -200, SCREEN, CARD_WIDTH)).toBe(CARD_WIDTH)
  })
})

describe('expandedWidth: what «Шире» opens to', () => {
  it('opens to the width the content asked for, not to the ceiling', () => {
    expect(expandedWidth(430, SCREEN)).toBe(430)
  })

  it('stops at the ceiling when the content wants more', () => {
    expect(expandedWidth(4000, SCREEN)).toBe(CARD_MAX_WIDTH)
  })

  it('has nothing to offer when the content already fits', () => {
    expect(expandedWidth(CARD_WIDTH, SCREEN)).toBeNull()
    expect(expandedWidth(120, SCREEN)).toBeNull()
  })

  it('never opens narrower than the full width', () => {
    expect(expandedWidth(CARD_WIDTH + 0.4, SCREEN)).toBe(CARD_WIDTH)
  })
})
