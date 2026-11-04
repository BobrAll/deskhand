/**
 * Real numbers, no Electron: the placement rules are arithmetic, so they are
 * tested as arithmetic. A 1440×900 display and a 600×400 one stand in for "a
 * laptop" and "the smallest window the card must survive".
 */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  BUBBLE_GAP,
  BUBBLE_MARGIN,
  boundsFor,
  clamp,
  placeAnchor,
  resizeAnchor,
  roomAround,
  xFor,
  yFor,
  type BubbleAnchor,
  type BubbleRect
} from './bubble'

const SCREEN: BubbleRect = { x: 0, y: 0, width: 1440, height: 900 }
const SMALL: BubbleRect = { x: 0, y: 0, width: 600, height: 400 }
const MIN = 8
const GAP = 10

function at(x: number, y: number): { x: number; y: number } {
  return { x, y }
}

describe('bubble: the numbers', () => {
  it('keeps the gap and the margin the card was tuned with', () => {
    expect(BUBBLE_GAP).toBe(10)
    expect(BUBBLE_MARGIN).toBe(8)
    expect(GAP).toBe(BUBBLE_GAP)
    expect(MIN).toBe(BUBBLE_MARGIN)
  })

  it('clamps to the range, and answers `min` for a number that is not one', () => {
    expect(clamp(5, 0, 10)).toBe(5)
    expect(clamp(-5, 0, 10)).toBe(0)
    expect(clamp(50, 0, 10)).toBe(10)
    expect(clamp(Number.NaN, 3, 10)).toBe(3)
    expect(clamp(Number.POSITIVE_INFINITY, 3, 10)).toBe(3)
  })
})

describe('bubble: room around the pointer', () => {
  it('measures both sides inside the work area', () => {
    expect(roomAround(at(100, 100), SCREEN)).toEqual({
      below: 900 - MIN - 110,
      above: 100 - GAP - MIN
    })
  })

  it('goes negative near an edge instead of lying about the room', () => {
    expect(roomAround(at(100, 895), SCREEN).below).toBeLessThan(0)
    expect(roomAround(at(100, 5), SCREEN).above).toBeLessThan(0)
  })
})

describe('bubble: placing a new card', () => {
  it('opens down and to the right of the pointer', () => {
    const anchor = placeAnchor(at(100, 100), SCREEN, 31, 112)

    expect(anchor).toMatchObject({ above: false, right: true, x: 110 })
    expect(boundsFor(anchor, 31, 112)).toEqual({ x: 110, y: 110, width: 112, height: 31 })
  })

  it('flips to the left of the pointer near the right edge', () => {
    const anchor = placeAnchor(at(1400, 100), SCREEN, 31, 112)

    expect(anchor.right).toBe(false)
    expect(anchor.x).toBe(1400 - GAP - 112)
  })

  it('flips above the pointer near the bottom edge', () => {
    const anchor = placeAnchor(at(700, 870), SCREEN, 31, 112)

    expect(anchor.above).toBe(true)
    expect(yFor(anchor, 31)).toBe(870 - GAP - 31)
  })

  it('stays below when the card does not fit above either', () => {
    // 600 tall card on a 400 pt display: no side has room, so it hangs below and
    // is clamped — a card half off screen is worse than a card over the pointer.
    const anchor = placeAnchor(at(300, 200), SMALL, 600, 112)

    expect(anchor.above).toBe(false)
    expect(yFor(anchor, 600)).toBe(0 + MIN)
  })

  it('never places the card off the left edge', () => {
    const anchor = placeAnchor(at(0, 100), SCREEN, 31, 112)

    expect(anchor.x).toBeGreaterThanOrEqual(MIN)
  })

  it('survives the smallest display with the smallest card', () => {
    const anchor = placeAnchor(at(300, 200), SMALL, 31, 44)
    const bounds = boundsFor(anchor, 31, 44)

    expect(bounds.x).toBeGreaterThanOrEqual(MIN)
    expect(bounds.y).toBeGreaterThanOrEqual(MIN)
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(SMALL.width)
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(SMALL.height)
  })
})

describe('bubble: the edges for a size', () => {
  const placed: BubbleAnchor = {
    point: at(700, 400),
    area: SCREEN,
    x: 710,
    above: false,
    right: true
  }

  it('grows away from the pointer, keeping the side it opened on', () => {
    expect(xFor(placed, 112)).toBe(710)
    expect(xFor(placed, 360)).toBe(710)
  })

  it('pins the far edge near the right edge instead of hopping over the pointer', () => {
    const nearEdge: BubbleAnchor = { ...placed, point: at(1300, 400), x: 1310 }

    expect(xFor(nearEdge, 112)).toBe(1310)
    expect(xFor(nearEdge, 360)).toBe(1440 - 360 - MIN)
  })

  it('clamps the vertical edge so the card stays inside the work area', () => {
    expect(yFor(placed, 31)).toBe(410)
    expect(yFor(placed, 520)).toBe(900 - 520 - MIN)
  })

  it('keeps a card above the pointer above it as it grows', () => {
    const above: BubbleAnchor = { ...placed, above: true, point: at(700, 800) }

    expect(yFor(above, 31)).toBe(800 - GAP - 31)
    expect(yFor(above, 520)).toBe(800 - GAP - 520)
  })

  it('rounds the window rectangle, never the remembered anchor', () => {
    const fractional: BubbleAnchor = { ...placed, x: 710.6, point: at(700.4, 400.4) }

    expect(boundsFor(fractional, 31.4, 112.4)).toEqual({
      x: 711,
      y: Math.round(yFor(fractional, 31.4)),
      width: 112,
      height: 31
    })
    expect(fractional.x).toBe(710.6)
  })
})

describe('bubble: resizing at the anchor', () => {
  const base: BubbleAnchor = {
    point: at(700, 400),
    area: SCREEN,
    x: 710,
    above: false,
    right: true
  }
  const inPlace: BubbleRect = { x: 710, y: 410, width: 112, height: 31 }

  it('re-derives both edges when the card is still where it was placed', () => {
    const next = resizeAnchor(base, inPlace, 200, 360, () => SCREEN)

    expect(next.x).toBe(710)
    expect(next.above).toBe(false)
    expect(yFor(next, 200)).toBe(410)
  })

  it('flips above when the answer outgrows the room below', () => {
    // Pointer at y=700: 182 pt of room below, 682 above. A 500 pt answer only
    // fits on the side the card did not open on.
    const low: BubbleAnchor = { ...base, point: at(700, 700), x: 710 }
    const dropped: BubbleRect = { x: 710, y: 710, width: 112, height: 31 }
    const next = resizeAnchor(low, dropped, 500, 360, () => SCREEN)

    expect(next.above).toBe(true)
    expect(yFor(next, 500)).toBe(700 - GAP - 500)
  })

  it('stays above when the card shrinks again', () => {
    // The flip is only undone when the *other* side becomes the only one that
    // fits. A card that hopped above the pointer and then shrinks stays there:
    // hopping back down mid-answer is the movement the anchor exists to prevent.
    const low: BubbleAnchor = { ...base, point: at(700, 700), x: 710 }
    const dropped: BubbleRect = { x: 710, y: 710, width: 112, height: 31 }
    const flipped = resizeAnchor(low, dropped, 500, 360, () => SCREEN)
    const bounds = boundsFor(flipped, 500, 360)
    const back = resizeAnchor(flipped, bounds, 31, 360, () => SCREEN)

    expect(back.above).toBe(true)
  })

  it('flips back below when the card is too tall for the side it is on', () => {
    // Above the pointer there are 382 pt of room, below 482. A 400 pt answer
    // fits only below, so the card hops back down.
    const above: BubbleAnchor = { ...base, above: true, point: at(700, 400), x: 710 }
    const bounds: BubbleRect = { x: 710, y: 8, width: 360, height: 400 }
    const next = resizeAnchor(above, bounds, 400, 360, () => SCREEN)

    expect(next.above).toBe(false)
  })

  it('leaves a card the user dragged where they put it', () => {
    const dropped: BubbleRect = { x: 200, y: 300, width: 112, height: 31 }
    const next = resizeAnchor(base, dropped, 31, 112, () => SCREEN)

    expect(next.x).toBe(200)
    expect(next.point.y).toBe(300 - GAP)
  })

  it('pulls a dragged card back when growing wider would carry it off screen', () => {
    const dropped: BubbleRect = { x: 1400, y: 300, width: 112, height: 31 }
    const next = resizeAnchor(base, dropped, 31, 360, () => SCREEN)

    expect(next.x).toBe(1440 - 360 - MIN)
  })

  it('re-reads the work area of the display the pointer is on', () => {
    const seen: Array<{ x: number; y: number }> = []
    resizeAnchor(base, inPlace, 200, 360, (point) => {
      seen.push(point)
      return SCREEN
    })

    expect(seen).toEqual([at(700, 400)])
  })

  it('re-reads the work area of the display the card was dropped on', () => {
    const seen: Array<{ x: number; y: number }> = []
    const dropped: BubbleRect = { x: 200, y: 300, width: 112, height: 31 }
    resizeAnchor(base, dropped, 31, 112, (point) => {
      seen.push(point)
      return SCREEN
    })

    expect(seen).toEqual([at(700, 400), at(200, 300)])
  })

  it('does not mutate the anchor it was given', () => {
    const before = JSON.parse(JSON.stringify(base)) as BubbleAnchor
    resizeAnchor(base, inPlace, 700, 360, () => SCREEN)

    expect(base).toEqual(before)
  })
})

describe('bubble: the geometry left windows.ts', () => {
  const source = readFileSync(join(__dirname, 'windows.ts'), 'utf8')

  it('no longer defines the placement functions itself', () => {
    for (const name of ['placeAnchor', 'roomAround', 'xFor', 'yFor']) {
      expect(source).not.toContain(`function ${name}`)
    }
  })

  it('no longer holds the gap and the margin as literals', () => {
    expect(source).not.toMatch(/const GAP = 10/)
    expect(source).not.toMatch(/const MARGIN = 8/)
  })
})
