import { describe, expect, it } from 'vitest'

import { isDrawable, parseAnnotationLine } from './annotations'

describe('parseAnnotationLine: marker recognition', () => {
  it('returns null for a line that is not protocol syntax', () => {
    expect(parseAnnotationLine('обычный текст')).toBeNull()
    expect(parseAnnotationLine('@username привет')).toBeNull()
    expect(parseAnnotationLine('@hover 0.1 0.2')).toBeNull()
    expect(parseAnnotationLine('')).toBeNull()
    expect(parseAnnotationLine('   ')).toBeNull()
    expect(parseAnnotationLine('текст @point 0.1 0.2')).toBeNull()
  })

  it('accepts every marker spelling, case-insensitively', () => {
    for (const marker of ['@point', '@draw', '@arrow', '@circle', '@box', '@underline']) {
      expect(parseAnnotationLine(`${marker} 0.1 0.2 0.3 0.4`), marker).not.toBeNull()
    }
    expect(parseAnnotationLine('@Point 0.1 0.2 0.3 0.4')).not.toBeNull()
    expect(parseAnnotationLine('@POINT 0.1 0.2 0.3 0.4')).not.toBeNull()
  })

  it('does not match a marker glued to a longer word', () => {
    expect(parseAnnotationLine('@pointless 0.1 0.2')).toBeNull()
  })

  it('ignores surrounding whitespace', () => {
    expect(parseAnnotationLine('   @point 0.1 0.2 0.3 0.4   ')).toEqual(
      parseAnnotationLine('@point 0.1 0.2 0.3 0.4')
    )
  })
})

describe('parseAnnotationLine: kinds', () => {
  it('reads the kind from the first token after the marker', () => {
    const kinds = ['circle', 'box', 'arrow', 'underline'] as const
    for (const kind of kinds) {
      const parsed = parseAnnotationLine(`@point ${kind} 0.1 0.2 0.3 0.4`)
      expect(parsed?.annotations[0].kind, kind).toBe(kind)
    }
  })

  it('accepts an uppercase kind', () => {
    expect(parseAnnotationLine('@point ARROW 0.1 0.2 0.3 0.4')?.annotations[0].kind).toBe('arrow')
  })

  it('defaults to circle when no kind is given', () => {
    expect(parseAnnotationLine('@point 0.1 0.2 0.3 0.4')?.annotations[0].kind).toBe('circle')
    expect(parseAnnotationLine('@box 0.1 0.2 0.3 0.4')?.annotations[0].kind).toBe('circle')
  })

  it('treats an unknown first token as the start of the coordinates', () => {
    // "big" is not a kind, so it is not consumed and the numbers are never found.
    expect(parseAnnotationLine('@point big 0.1 0.2')).toEqual({ annotations: [] })
  })
})

describe('parseAnnotationLine: numbers', () => {
  it('reads four coordinates as a start→end pair', () => {
    expect(parseAnnotationLine('@point arrow 0.5 0.8 0.82 0.11')?.annotations[0]).toEqual({
      kind: 'arrow',
      from: { x: 0.5, y: 0.8 },
      to: { x: 0.82, y: 0.11 },
      label: undefined
    })
  })

  it('reads two coordinates as a circle centre with a default radius', () => {
    expect(parseAnnotationLine('@point 0.5 0.5')?.annotations[0]).toEqual({
      kind: 'circle',
      from: { x: 0.5, y: 0.5 },
      to: { x: 0.53, y: 0.53 },
      label: undefined
    })
  })

  it('ignores a third coordinate and falls back to the default radius', () => {
    expect(parseAnnotationLine('@point arrow 0.1 0.2 0.4')?.annotations[0]).toEqual({
      kind: 'arrow',
      from: { x: 0.1, y: 0.2 },
      to: { x: 0.13, y: 0.23 },
      label: undefined
    })
  })

  it('ignores coordinates after the fourth', () => {
    expect(parseAnnotationLine('@point arrow 0.1 0.2 0.3 0.4 0.9 0.9')?.annotations[0]).toEqual({
      kind: 'arrow',
      from: { x: 0.1, y: 0.2 },
      to: { x: 0.3, y: 0.4 },
      label: '0.9 0.9'
    })
  })

  it('splits on commas and semicolons as well as whitespace', () => {
    const expected = {
      kind: 'arrow',
      from: { x: 0.5, y: 0.8 },
      to: { x: 0.82, y: 0.11 },
      label: undefined
    }
    expect(parseAnnotationLine('@point arrow, 0.5, 0.8, 0.82, 0.11')?.annotations[0]).toEqual(
      expected
    )
    expect(parseAnnotationLine('@point arrow;0.5;0.8;0.82;0.11')?.annotations[0]).toEqual(expected)
  })

  // KNOWN BUG: characterization — commas separate tokens, so "0,5" is split into
  // "0" and "5" before the decimal-comma fallback can run.
  it('mangles a decimal comma (known bug)', () => {
    expect(parseAnnotationLine('@point 0,5 0,2 0,3 0,4')?.annotations[0].from).toEqual({
      x: 0,
      y: 0.05
    })
  })

  it('scales percentages down', () => {
    expect(parseAnnotationLine('@point arrow 50 80 82 11')?.annotations[0]).toEqual({
      kind: 'arrow',
      from: { x: 0.5, y: 0.8 },
      to: { x: 0.82, y: 0.11 },
      label: undefined
    })
  })

  it('does not scale a value at or below the 1.5 threshold, then clamps it', () => {
    expect(parseAnnotationLine('@point arrow 1.5 0 1.5 1.5')?.annotations[0].from).toEqual({
      x: 1,
      y: 0
    })
    expect(parseAnnotationLine('@point arrow 1.51 0 1.5 1.5')?.annotations[0].from).toEqual({
      x: 0.0151,
      y: 0
    })
  })

  it('clamps coordinates into 0..1', () => {
    expect(parseAnnotationLine('@point arrow -5 2 0.5 0.5')?.annotations[0]).toEqual({
      kind: 'arrow',
      from: { x: 0, y: 0.02 },
      to: { x: 0.5, y: 0.5 },
      label: undefined
    })
  })

  it('swallows garbage coordinates instead of drawing', () => {
    expect(parseAnnotationLine('@point')).toEqual({ annotations: [] })
    expect(parseAnnotationLine('@point arrow')).toEqual({ annotations: [] })
    expect(parseAnnotationLine('@point 0.5')).toEqual({ annotations: [] })
    expect(parseAnnotationLine('@point arrow abc def')).toEqual({ annotations: [] })
    expect(parseAnnotationLine('@point arrow 0.1 abc 0.3 0.4')).toEqual({ annotations: [] })
  })

  it('swallows a degenerate shape for every kind except circle', () => {
    for (const kind of ['box', 'arrow', 'underline']) {
      expect(parseAnnotationLine(`@point ${kind} 0.5 0.5 0.5 0.5`), kind).toEqual({
        annotations: []
      })
      // Exactly at the MIN_SIDE threshold (0.004) is still degenerate.
      expect(parseAnnotationLine(`@point ${kind} 0.5 0.5 0.503 0.503`), kind).toEqual({
        annotations: []
      })
    }
  })

  it('keeps a shape that is just above the degeneracy threshold', () => {
    const parsed = parseAnnotationLine('@point arrow 0.5 0.5 0.505 0.505')
    expect(parsed?.annotations).toHaveLength(1)
  })

  it('keeps a single point as a circle', () => {
    const parsed = parseAnnotationLine('@point circle 0.5 0.5 0.5 0.5')
    expect(parsed?.annotations).toHaveLength(1)
    expect(parsed?.annotations[0]).toEqual({
      kind: 'circle',
      from: { x: 0.5, y: 0.5 },
      to: { x: 0.5, y: 0.5 },
      label: undefined
    })
  })
})

describe('parseAnnotationLine: labels', () => {
  it('strips one layer of «», "", \'\', (), []', () => {
    for (const wrapped of ['«Сюда»', '"Сюда"', "'Сюда'", '(Сюда)', '[Сюда]']) {
      expect(parseAnnotationLine(`@point arrow 0.1 0.2 0.3 0.4 ${wrapped}`)?.annotations[0].label).toBe(
        'Сюда'
      )
    }
  })

  it('joins multi-word labels and collapses whitespace', () => {
    expect(
      parseAnnotationLine('@point arrow 0.1 0.2 0.3 0.4 «нажми   сюда»')?.annotations[0].label
    ).toBe('нажми сюда')
  })

  it('drops a label that is only quotes', () => {
    expect(parseAnnotationLine('@point arrow 0.1 0.2 0.3 0.4 «»')?.annotations[0].label).toBeUndefined()
  })

  it('has no label when nothing follows the coordinates', () => {
    expect(parseAnnotationLine('@point arrow 0.1 0.2 0.3 0.4')?.annotations[0].label).toBeUndefined()
  })

  it('truncates a label longer than 90 characters with an ellipsis', () => {
    const label = parseAnnotationLine(`@point arrow 0.1 0.2 0.3 0.4 ${'я'.repeat(200)}`)?.annotations[0]
      .label

    expect(label).toHaveLength(90)
    expect(label?.endsWith('…')).toBe(true)
    expect(label?.slice(0, -1)).toBe('я'.repeat(89))
  })

  it('keeps a label of exactly 90 characters intact', () => {
    expect(
      parseAnnotationLine(`@point arrow 0.1 0.2 0.3 0.4 ${'я'.repeat(90)}`)?.annotations[0].label
    ).toBe('я'.repeat(90))
  })
})

describe('isDrawable', () => {
  it('accepts a normal shape', () => {
    expect(
      isDrawable({ kind: 'arrow', from: { x: 0.1, y: 0.2 }, to: { x: 0.3, y: 0.4 } })
    ).toBe(true)
  })

  it('rejects a point outside the image', () => {
    expect(
      isDrawable({ kind: 'arrow', from: { x: -0.1, y: 0.5 }, to: { x: 0.6, y: 0.5 } })
    ).toBe(false)
    expect(
      isDrawable({ kind: 'arrow', from: { x: 0.5, y: 0.5 }, to: { x: 1.1, y: 0.5 } })
    ).toBe(false)
  })

  it('rejects a zero-length circle, arrow and underline', () => {
    for (const kind of ['circle', 'arrow', 'underline'] as const) {
      expect(isDrawable({ kind, from: { x: 0.5, y: 0.5 }, to: { x: 0.5, y: 0.5 } }), kind).toBe(
        false
      )
    }
  })

  it('accepts a zero-length box only when both sides exceed the minimum', () => {
    expect(
      isDrawable({ kind: 'box', from: { x: 0.1, y: 0.1 }, to: { x: 0.5, y: 0.101 } })
    ).toBe(false)
    expect(isDrawable({ kind: 'box', from: { x: 0.1, y: 0.1 }, to: { x: 0.5, y: 0.5 } })).toBe(true)
  })

  it('rejects a box wider or taller than 0.95 of the screen', () => {
    expect(isDrawable({ kind: 'box', from: { x: 0.01, y: 0.01 }, to: { x: 0.99, y: 0.99 } })).toBe(
      false
    )
    expect(isDrawable({ kind: 'box', from: { x: 0, y: 0 }, to: { x: 1, y: 1 } })).toBe(false)
    // Just under the limit on both axes is still drawable.
    expect(isDrawable({ kind: 'box', from: { x: 0.02, y: 0.02 }, to: { x: 0.96, y: 0.96 } })).toBe(
      true
    )
    // Exactly 0.95 on one axis is already rejected.
    expect(isDrawable({ kind: 'box', from: { x: 0.02, y: 0.02 }, to: { x: 0.97, y: 0.9 } })).toBe(
      false
    )
  })

  it('accepts shapes that touch the border', () => {
    expect(isDrawable({ kind: 'arrow', from: { x: 0, y: 0 }, to: { x: 1, y: 1 } })).toBe(true)
  })
})
