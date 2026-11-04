import { describe, expect, it } from 'vitest'

import type { ScreenRect } from '@shared/types'
import { toFramePoint, toScreenPoint } from './geometry'

const area: ScreenRect = { x: 100, y: 50, width: 1000, height: 500 }

describe('toScreenPoint: fractions become screen points', () => {
  it('maps the frame corners onto the area corners', () => {
    expect(toScreenPoint({ x: 0, y: 0 }, area)).toEqual({ x: 100, y: 50 })
    expect(toScreenPoint({ x: 1, y: 1 }, area)).toEqual({ x: 1100, y: 550 })
  })

  it('maps the centre of the frame onto the centre of the area', () => {
    expect(toScreenPoint({ x: 0.5, y: 0.5 }, area)).toEqual({ x: 600, y: 300 })
  })

  it('is linear, not pixel based: a Retina-sized area only changes the origin and size', () => {
    const retina: ScreenRect = { x: 0, y: 0, width: 2880, height: 1800 }
    expect(toScreenPoint({ x: 0.25, y: 0.5 }, retina)).toEqual({ x: 720, y: 900 })
    expect(toScreenPoint({ x: 0.25, y: 0.5 }, area)).toEqual({ x: 350, y: 300 })
  })

  it('clamps a fraction outside 0..1 to the frame edge', () => {
    expect(toScreenPoint({ x: -0.5, y: 1.5 }, area)).toEqual({ x: 100, y: 550 })
  })

  it('treats a non-finite fraction as 0 rather than producing NaN', () => {
    expect(toScreenPoint({ x: Number.NaN, y: Number.POSITIVE_INFINITY }, area)).toEqual({
      x: 100,
      y: 50
    })
  })

  it('keeps a zero-size area at its own origin', () => {
    expect(toScreenPoint({ x: 0.7, y: 0.7 }, { x: 10, y: 20, width: 0, height: 0 })).toEqual({
      x: 10,
      y: 20
    })
  })

  it('handles negative screen origins (a display to the left of the main one)', () => {
    const left: ScreenRect = { x: -1440, y: 0, width: 1440, height: 900 }
    expect(toScreenPoint({ x: 1, y: 0 }, left)).toEqual({ x: 0, y: 0 })
    expect(toScreenPoint({ x: 0, y: 0 }, left)).toEqual({ x: -1440, y: 0 })
  })
})

describe('toFramePoint: the reverse direction', () => {
  it('maps the area back to 0..1', () => {
    expect(toFramePoint({ x: 100, y: 50 }, area)).toEqual({ x: 0, y: 0 })
    expect(toFramePoint({ x: 600, y: 300 }, area)).toEqual({ x: 0.5, y: 0.5 })
  })

  it('clamps a point outside the area', () => {
    expect(toFramePoint({ x: 0, y: 0 }, area)).toEqual({ x: 0, y: 0 })
    expect(toFramePoint({ x: 5000, y: 5000 }, area)).toEqual({ x: 1, y: 1 })
  })

  it('treats a zero-size area as one point wide, so it cannot divide by zero', () => {
    const result = toFramePoint({ x: 10, y: 20 }, { x: 10, y: 20, width: 0, height: 0 })
    expect(result).toEqual({ x: 0, y: 0 })
    expect(Number.isFinite(result.x) && Number.isFinite(result.y)).toBe(true)
  })

  it('treats a non-finite point as 0 rather than producing NaN', () => {
    expect(toFramePoint({ x: Number.NaN, y: Number.NaN }, area)).toEqual({ x: 0, y: 0 })
  })

  it('round-trips every fraction through the screen space', () => {
    for (const x of [0, 0.1, 0.333, 0.5, 0.999, 1]) {
      for (const y of [0, 0.2, 0.5, 0.75, 1]) {
        const back = toFramePoint(toScreenPoint({ x, y }, area), area)
        expect(back.x).toBeCloseTo(x, 10)
        expect(back.y).toBeCloseTo(y, 10)
      }
    }
  })
})
