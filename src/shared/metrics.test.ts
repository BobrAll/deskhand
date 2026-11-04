import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import { BUBBLE_MIN_WIDTH, BUBBLE_NARROW_WIDTH, BUBBLE_VOICE_WIDTH, BUBBLE_WIDTH } from './metrics'

/**
 * These four numbers are the one thing that has to agree in two processes: main
 * sizes the window with them, the renderer decides where a line wraps and which
 * width to ask for. The values are pinned literally — a change here is a visual
 * change and should fail a test rather than quietly reshape the card.
 *
 * The last test is a tripwire for the bug this module was created to prevent:
 * a width written out again in `windows.ts` or in the overlay renderer.
 */

describe('metrics: the bubble widths', () => {
  it('keeps the folded pill at 112', () => {
    expect(BUBBLE_NARROW_WIDTH).toBe(112)
  })

  it('keeps the voice surface at 80 — the macOS transparency floor', () => {
    expect(BUBBLE_VOICE_WIDTH).toBe(80)
  })

  it('keeps the widest card at 360', () => {
    expect(BUBBLE_WIDTH).toBe(360)
  })

  it('keeps the floor at 44, below the voice width', () => {
    expect(BUBBLE_MIN_WIDTH).toBe(44)
    expect(BUBBLE_MIN_WIDTH).toBeLessThan(BUBBLE_VOICE_WIDTH)
  })

  it('orders the widths: floor < voice < narrow < full', () => {
    expect(BUBBLE_MIN_WIDTH).toBeLessThan(BUBBLE_VOICE_WIDTH)
    expect(BUBBLE_VOICE_WIDTH).toBeLessThan(BUBBLE_NARROW_WIDTH)
    expect(BUBBLE_NARROW_WIDTH).toBeLessThan(BUBBLE_WIDTH)
  })
})

describe('metrics: the literals are gone from both processes', () => {
  const read = (path: string): string => readFileSync(resolve(__dirname, '..', path), 'utf8')

  it('does not let the main process write the widths out again', () => {
    const source = read('main/windows/index.ts')
    expect(source).not.toMatch(/=\s*360\b/)
    expect(source).not.toMatch(/=\s*112\b/)
    expect(source).not.toMatch(/=\s*80\b/)
  })

  it('does not let the overlay renderer write the widths out again', () => {
    const source = read('renderer/overlay/App.tsx')
    expect(source).not.toMatch(/=\s*360\b/)
    expect(source).not.toMatch(/=\s*112\b/)
    expect(source).not.toMatch(/=\s*80\b/)
  })
})

describe('metrics: the widths have one source', () => {
  const read = (path: string): string => readFileSync(resolve(__dirname, '..', path), 'utf8')

  it('is what the main process sizes the window with', () => {
    const source = read('main/windows/index.ts')
    for (const name of ['BUBBLE_WIDTH', 'BUBBLE_NARROW_WIDTH', 'BUBBLE_VOICE_WIDTH', 'BUBBLE_MIN_WIDTH']) {
      expect(source, name).toContain(name)
    }
    expect(source).not.toMatch(/const BUBBLE_(WIDTH|NARROW_WIDTH|VOICE_WIDTH|MIN_WIDTH) = \d/)
  })

  it('is what the overlay renderer lays itself out with', () => {
    // R13 moved the renderer's constants into `overlay/metrics.ts`, so the
    // renderer half of this guard reads that file: the widths still have to come
    // from here and still must not be written out anywhere in the renderer.
    const source = read('renderer/overlay/metrics.ts')
    for (const name of ['BUBBLE_WIDTH', 'BUBBLE_NARROW_WIDTH', 'BUBBLE_VOICE_WIDTH']) {
      expect(source, name).toContain(name)
    }
    expect(source).not.toMatch(/const (NARROW_WIDTH|VOICE_WIDTH|FULL_WIDTH) = \d/)
    expect(read('renderer/overlay/App.tsx')).not.toMatch(/const (NARROW_WIDTH|VOICE_WIDTH|FULL_WIDTH) = \d/)
  })
})
