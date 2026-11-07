import { describe, expect, it } from 'vitest'

import type { AxElementInfo, AxProbe, ScreenRect } from '@shared/types'
import { centerOf, isTextField, normalizeText, resolveTarget, textMatchScore } from './targeting'

const area: ScreenRect = { x: 0, y: 0, width: 1440, height: 900 }

function element(overrides: Partial<AxElementInfo> = {}): AxElementInfo {
  return {
    role: 'AXButton',
    frame: { x: 100, y: 100, width: 80, height: 30 },
    pressable: true,
    ...overrides
  }
}

function probe(elements: AxElementInfo[]): AxProbe {
  return {
    pid: 42,
    app: 'Safari',
    chain: [],
    targets: elements,
    focused: null,
    elapsedMs: 5
  }
}

describe('normalizeText', () => {
  it('lowercases and replaces ё', () => {
    expect(normalizeText('Ёлка')).toBe('елка')
  })

  it('drops quotes and punctuation', () => {
    expect(normalizeText('«Экспорт…»')).toBe('экспорт')
  })

  it('collapses whitespace and trims', () => {
    expect(normalizeText('  два   слова ')).toBe('два слова')
  })

  it('returns an empty string for nullish input', () => {
    expect(normalizeText(null)).toBe('')
    expect(normalizeText(undefined)).toBe('')
    expect(normalizeText('')).toBe('')
  })
})

describe('textMatchScore', () => {
  it('scores an exact match as 1', () => {
    expect(textMatchScore('Экспорт', 'экспорт')).toBe(1)
  })

  it('scores 0 when either side is empty', () => {
    expect(textMatchScore('', 'экспорт')).toBe(0)
    expect(textMatchScore('экспорт', '')).toBe(0)
  })

  it('rewards containment above the weak floor', () => {
    expect(textMatchScore('Экспорт', 'Экспорт в PDF')).toBeGreaterThan(0.65)
  })

  it('ignores containment of a very short fragment', () => {
    // "ок" is inside "Окно" but is not a name worth matching.
    expect(textMatchScore('ок', 'Окно')).toBeLessThan(0.65)
  })

  it('tolerates a small typo', () => {
    expect(textMatchScore('Экспорт', 'Экспортт')).toBeGreaterThan(0.8)
  })

  it('scores unrelated names low', () => {
    expect(textMatchScore('Экспорт', 'Отмена')).toBeLessThan(0.4)
  })

  it('rewards a shared word', () => {
    expect(textMatchScore('Сохранить файл', 'Сохранить')).toBeGreaterThan(0.6)
  })
})

describe('centerOf', () => {
  it('returns the middle of a rectangle', () => {
    expect(centerOf({ x: 10, y: 20, width: 100, height: 50 })).toEqual({ x: 60, y: 45 })
  })
})

describe('isTextField', () => {
  it('is true for an editable element', () => {
    expect(isTextField(element({ editable: true }))).toBe(true)
  })

  it('is false for a non-editable element', () => {
    expect(isTextField(element({ editable: false }))).toBe(false)
  })

  it('is null when there is nothing to judge', () => {
    expect(isTextField(null)).toBeNull()
    expect(isTextField(undefined)).toBeNull()
    expect(isTextField({ role: '' })).toBeNull()
  })
})

describe('resolveTarget: no candidates', () => {
  it('falls back to the model point with low confidence', () => {
    const result = resolveTarget({
      rough: { x: 200, y: 200 },
      label: 'Экспорт',
      probe: null,
      area
    })

    expect(result).toMatchObject({
      point: { x: 200, y: 200 },
      element: null,
      source: 'model',
      shift: 0,
      confidence: 0.15
    })
  })

  it('clamps the model point into the frame', () => {
    const result = resolveTarget({
      rough: { x: -50, y: 5000 },
      probe: null,
      area
    })

    // The frame is half-open: the last addressable pixel is height - 1.
    expect(result.point).toEqual({ x: 0, y: 899 })
  })
})

describe('resolveTarget: the point is inside a control', () => {
  it('keeps the aim and reports the element', () => {
    const button = element()
    const result = resolveTarget({
      rough: { x: 140, y: 115 },
      label: 'Экспорт',
      probe: probe([element({ title: 'Экспорт' })]),
      area
    })

    expect(result.source).toBe('point')
    expect(result.confidence).toBe(0.7)
    expect(result.point.x).toBeGreaterThanOrEqual(button.frame!.x)
  })

  it('picks the smallest control under the point', () => {
    const result = resolveTarget({
      rough: { x: 140, y: 115 },
      probe: probe([
        element({ title: 'Строка', frame: { x: 0, y: 0, width: 1200, height: 800 } }),
        element({ title: 'Кнопка' })
      ]),
      area
    })

    expect(result.element?.title).toBe('Кнопка')
  })

  it('nudges a point on the edge inside the control', () => {
    const result = resolveTarget({
      rough: { x: 100, y: 100 },
      probe: probe([element({ frame: { x: 100, y: 100, width: 80, height: 30 } })]),
      area
    })

    expect(result.point.x).toBeGreaterThan(100)
    expect(result.point.y).toBeGreaterThan(100)
  })
})

describe('resolveTarget: the label wins when the point is empty space', () => {
  it('moves the click to the centre of the named control', () => {
    const result = resolveTarget({
      rough: { x: 500, y: 500 },
      label: 'Экспорт',
      probe: probe([
        element({ title: 'Экспорт', frame: { x: 280, y: 290, width: 80, height: 30 } })
      ]),
      area
    })

    expect(result.source).toBe('label')
    expect(result.point).toEqual({ x: 320, y: 305 })
    expect(result.shift).toBeGreaterThan(0)
  })

  it('reports a conflict when the point sits inside a differently named control', () => {
    // No element carries the label, so the only evidence is the control the
    // point landed in — and its name contradicts the label.
    const result = resolveTarget({
      rough: { x: 140, y: 115 },
      label: 'Клавиатура',
      probe: probe([element({ title: 'Звук', frame: { x: 100, y: 100, width: 80, height: 30 } })]),
      area
    })

    expect(result.conflict).toBe('Звук')
    expect(result.confidence).toBe(0.2)
  })

  it('prefers a strong label match elsewhere over the control under the point', () => {
    const result = resolveTarget({
      rough: { x: 140, y: 115 },
      label: 'Клавиатура',
      probe: probe([
        element({ title: 'Звук', frame: { x: 100, y: 100, width: 80, height: 30 } }),
        element({ title: 'Клавиатура', frame: { x: 700, y: 400, width: 120, height: 30 } })
      ]),
      area
    })

    expect(result.source).toBe('label')
    expect(result.element?.title).toBe('Клавиатура')
  })

  it('trusts containment when the contained element agrees with the label', () => {
    const result = resolveTarget({
      rough: { x: 140, y: 115 },
      label: 'Экспорт',
      probe: probe([element({ title: 'Экспорт' })]),
      area
    })

    expect(result.conflict).toBeUndefined()
    expect(result.source).toBe('point')
  })

  it('trusts containment when the contained element has no name', () => {
    const result = resolveTarget({
      rough: { x: 140, y: 115 },
      label: 'Клавиатура',
      probe: probe([element({ frame: { x: 100, y: 100, width: 80, height: 30 } })]),
      area
    })

    expect(result.conflict).toBeUndefined()
    expect(result.source).toBe('point')
  })
})

describe('resolveTarget: snapping to a neighbour', () => {
  it('snaps to the nearest control when the point is just outside it', () => {
    const result = resolveTarget({
      rough: { x: 260, y: 115 },
      probe: probe([
        element({ title: 'Экспорт', frame: { x: 280, y: 100, width: 80, height: 30 } })
      ]),
      area
    })

    expect(result.source).toBe('snap')
    expect(result.point).toEqual({ x: 320, y: 115 })
  })

  it('refuses to snap to a neighbour with a different visible name', () => {
    const result = resolveTarget({
      rough: { x: 260, y: 115 },
      label: 'Экспорт',
      probe: probe([element({ title: 'Отмена', frame: { x: 280, y: 100, width: 80, height: 30 } })]),
      area
    })

    expect(result.source).toBe('model')
  })

  it('ignores a control that is too far away', () => {
    const result = resolveTarget({
      rough: { x: 700, y: 700 },
      probe: probe([element({ frame: { x: 100, y: 100, width: 80, height: 30 } })]),
      area
    })

    expect(result.source).toBe('model')
  })

  it('reaches 48 points even when the frame is too small to earn that reach', () => {
    // On a small frame the diagonal-based reach shrinks below the floor, so this
    // is the only place SNAP_MIN is the deciding number: 45 points out snaps,
    // because the floor is 48 and not something smaller.
    const result = resolveTarget({
      rough: { x: 225, y: 115 },
      probe: probe([element({ frame: { x: 100, y: 100, width: 80, height: 30 } })]),
      area: { x: 0, y: 0, width: 600, height: 400 }
    })

    expect(result.source).toBe('snap')
  })

  it('does not reach past the diagonal-based limit on a large frame', () => {
    // 100 points away on a 1440×900 frame is outside reach; the same gap would
    // be inside it if the share of the diagonal were loosened.
    const result = resolveTarget({
      rough: { x: 280, y: 115 },
      probe: probe([element({ frame: { x: 100, y: 100, width: 80, height: 30 } })]),
      area
    })

    expect(result.source).toBe('model')
  })

  it('caps the reach at 160 points even on a 4K frame', () => {
    // On 3840×2160 the diagonal-based reach would be ~220, and an uncapped one
    // would start guessing at controls two hundred points from the aim. 180 away
    // is outside the cap, so this is where the ceiling does its work.
    const result = resolveTarget({
      rough: { x: 360, y: 115 },
      probe: probe([element({ frame: { x: 100, y: 100, width: 80, height: 30 } })]),
      area: { x: 0, y: 0, width: 3840, height: 2160 }
    })

    expect(result.source).toBe('model')
  })
})

describe('resolveTarget: how strict a far-away label match has to be', () => {
  it('rejects a label that is merely similar when the point is nowhere near it', () => {
    // «Отмена» vs «Отменить» is a real pair of neighbours on screen, so the floor
    // sits above their score: a similarity that close must not move the click.
    expect(textMatchScore('Отмена', 'Отменить')).toBeLessThan(0.75)

    const result = resolveTarget({
      rough: { x: 700, y: 700 },
      label: 'Отмена',
      probe: probe([element({ title: 'Отменить', frame: { x: 100, y: 100, width: 80, height: 30 } })]),
      area
    })

    expect(result.source).toBe('model')
  })
})

describe('resolveTarget: elements that cannot be targets', () => {
  it('ignores an element that is not pressable or editable', () => {
    const result = resolveTarget({
      rough: { x: 140, y: 115 },
      probe: probe([
        element({ title: 'Текст', pressable: false, role: 'AXStaticText' })
      ]),
      area
    })

    expect(result.source).toBe('model')
  })

  it('ignores a container that covers most of the frame', () => {
    const result = resolveTarget({
      rough: { x: 700, y: 400 },
      probe: probe([
        element({ title: 'Окно', frame: { x: 0, y: 0, width: 1400, height: 880 } })
      ]),
      area
    })

    expect(result.source).toBe('model')
  })

  it('ignores an element without a frame', () => {
    const result = resolveTarget({
      rough: { x: 140, y: 115 },
      probe: probe([element({ title: 'Экспорт', frame: null })]),
      area
    })

    expect(result.source).toBe('model')
  })

  it('ignores an element whose centre is outside the captured frame', () => {
    const result = resolveTarget({
      rough: { x: 140, y: 115 },
      probe: probe([element({ title: 'Экспорт', frame: { x: 2000, y: 100, width: 80, height: 30 } })]),
      area
    })

    expect(result.source).toBe('model')
  })

  it('de-duplicates identical elements', () => {
    const duplicate = element({ title: 'Экспорт' })
    const result = resolveTarget({
      rough: { x: 140, y: 115 },
      probe: probe([duplicate, { ...duplicate }]),
      area
    })

    expect(result.source).toBe('point')
  })
})

describe('resolveTarget: icon controls', () => {
  it('finds an icon by its accessibility tooltip even when the point missed it', () => {
    const icon = element({ help: 'Показать загрузки', frame: { x: 240, y: 100, width: 24, height: 24 } })
    expect(resolveTarget({ rough: { x: 195, y: 115 }, label: 'Показать загрузки', probe: probe([icon]), area }))
      .toMatchObject({ source: 'label', point: { x: 252, y: 112 } })
  })

  it('snaps to an unnamed toggle despite its generic role and numeric state', () => {
    const icon = element({ role: 'AXCheckBox', roleDescription: 'флажок', value: '0',
      frame: { x: 240, y: 100, width: 24, height: 24 } })
    expect(resolveTarget({ rough: { x: 230, y: 111 }, label: 'Уведомления', probe: probe([icon]), area }))
      .toMatchObject({ source: 'snap', point: { x: 252, y: 112 } })
  })

  it('centres the click on the actual icon instead of picking a smaller neighbour across the edge', () => {
    const icon = element({ frame: { x: 240, y: 100, width: 24, height: 24 } })
    const neighbour = element({ frame: { x: 264, y: 102, width: 16, height: 20 } })
    expect(resolveTarget({ rough: { x: 263, y: 111 }, label: 'Настройки', probe: probe([icon, neighbour]), area }))
      .toMatchObject({ source: 'point', point: { x: 252, y: 112 } })
  })
})

it('uses the named Dock icon when the hit test landed on its neighbor', () => {
  const wrong = element({ role: 'AXDockItem', title: 'Notes', frame: { x: 200, y: 850, width: 40, height: 40 } })
  const wanted = element({ role: 'AXDockItem', title: 'Calendar', frame: { x: 250, y: 850, width: 40, height: 40 } })
  const tree = { ...probe([wanted]), chain: [wrong] }
  expect(resolveTarget({ rough: { x: 230, y: 870 }, label: 'Calendar', probe: tree, area }))
    .toMatchObject({ source: 'label', point: { x: 270, y: 870 }, element: wanted })
})
