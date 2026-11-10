import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import { CARD_MIN_WIDTH, CARD_NARROW_WIDTH, CARD_VOICE_WIDTH, CARD_WIDTH } from './metrics'

/**
 * These four numbers are the one thing that has to agree in two processes: main
 * sizes the window with them, the renderer decides where a line wraps and which
 * width to ask for. The values are pinned literally — a change here is a visual
 * change and should fail a test rather than quietly reshape the card.
 *
 * The last test is a tripwire for the bug this module was created to prevent:
 * a width written out again in `windows.ts` or in the overlay renderer.
 */

describe('metrics: the card widths', () => {
  it('keeps the folded pill at 112', () => {
    expect(CARD_NARROW_WIDTH).toBe(112)
  })

  it('keeps the voice surface at 80 — the macOS transparency floor', () => {
    expect(CARD_VOICE_WIDTH).toBe(80)
  })

  it('keeps the widest card at 360', () => {
    expect(CARD_WIDTH).toBe(360)
  })

  it('keeps the floor at 44, below the voice width', () => {
    expect(CARD_MIN_WIDTH).toBe(44)
    expect(CARD_MIN_WIDTH).toBeLessThan(CARD_VOICE_WIDTH)
  })

  it('orders the widths: floor < voice < narrow < full', () => {
    expect(CARD_MIN_WIDTH).toBeLessThan(CARD_VOICE_WIDTH)
    expect(CARD_VOICE_WIDTH).toBeLessThan(CARD_NARROW_WIDTH)
    expect(CARD_NARROW_WIDTH).toBeLessThan(CARD_WIDTH)
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
    for (const name of ['CARD_WIDTH', 'CARD_NARROW_WIDTH', 'CARD_VOICE_WIDTH', 'CARD_MIN_WIDTH']) {
      expect(source, name).toContain(name)
    }
    expect(source).not.toMatch(/const CARD_(WIDTH|NARROW_WIDTH|VOICE_WIDTH|MIN_WIDTH) = \d/)
  })

  it('is what the overlay renderer lays itself out with', () => {
    // The renderer imports these names instead of re-exporting them, and
    // `cardMetrics.ts` deliberately holds none of them, so the guard reads the
    // file that actually sizes the card.
    const cardWidth = read('renderer/overlay/cardWidth.ts')
    for (const name of ['CARD_WIDTH', 'CARD_NARROW_WIDTH', 'CARD_VOICE_WIDTH']) {
      expect(cardWidth, name).toContain(name)
    }
    for (const file of ['renderer/overlay/cardWidth.ts', 'renderer/overlay/App.tsx', 'renderer/overlay/cardMetrics.ts']) {
      expect(read(file), file).not.toMatch(/const (NARROW_WIDTH|VOICE_WIDTH|FULL_WIDTH) = \d/)
    }
  })
})
