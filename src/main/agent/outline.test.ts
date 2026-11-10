import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { AxElementInfo, AxProbe, ScreenRect } from '@shared/types'

const { helperProbe } = vi.hoisted(() => ({ helperProbe: vi.fn() }))

vi.mock('../native/helper', () => ({ helperProbe }))

import { describeScreen, formatOutline } from './outline'

const area: ScreenRect = { x: 0, y: 0, width: 1000, height: 800 }

function element(overrides: Partial<AxElementInfo> = {}): AxElementInfo {
  return {
    role: 'AXButton',
    title: 'Экспорт',
    frame: { x: 100, y: 100, width: 80, height: 30 },
    pressable: true,
    ...overrides
  }
}

function probe(targets: AxElementInfo[]): AxProbe {
  return { pid: 42, targets, elapsedMs: 5 }
}

/** The element lines only: two spaces, then the x fraction. Skips the header. */
function body(outline: string | null): string[] {
  if (outline === null) return []
  return outline.split('\n').filter((line) => /^ {2}\d\.\d{3} /.test(line))
}

beforeEach(() => {
  helperProbe.mockReset()
})

describe('formatOutline: which elements are listed', () => {
  it('writes one line per named pressable element with 3-decimal fractions', () => {
    const outline = formatOutline(probe([element()]), null, area)

    expect(outline).toContain('[Элементы активного окна]')
    expect(body(outline)).toEqual(['  0.140 0.144  кнопка «Экспорт»'])
  })

  it('drops an element that is neither pressable nor editable', () => {
    expect(formatOutline(probe([element({ pressable: false })]), null, area)).toBeNull()
  })

  it('drops an element without a frame', () => {
    expect(formatOutline(probe([element({ frame: null })]), null, area)).toBeNull()
    expect(formatOutline(probe([element({ frame: undefined })]), null, area)).toBeNull()
  })

  it('drops an element smaller than 2x2 (a hairline or a collapsed row)', () => {
    const tiny = { x: 100, y: 100, width: 1, height: 30 }
    expect(formatOutline(probe([element({ frame: tiny })]), null, area)).toBeNull()
  })

  it('drops an element whose centre is outside the captured area', () => {
    const outside = { x: 2000, y: 100, width: 80, height: 30 }
    expect(formatOutline(probe([element({ frame: outside })]), null, area)).toBeNull()
  })

  it('drops an element outside the window bounds when they are given', () => {
    const bounds: ScreenRect = { x: 0, y: 0, width: 100, height: 100 }
    // The centre of the default element is (140, 115): inside the area, outside the window.
    expect(formatOutline(probe([element()]), bounds, area)).toBeNull()
    const inside = element({ frame: { x: 10, y: 10, width: 40, height: 20 } })
    expect(formatOutline(probe([inside]), bounds, area)).not.toBeNull()
  })

  it('keeps an editable only when it is a place to type', () => {
    const outline = formatOutline(
      probe([
        element({ role: 'AXTextField', title: 'Поиск', pressable: false, editable: true }),
        element({ role: 'AXButton', pressable: false, editable: true }),
        element({ role: 'AXTextArea', title: 'Заметка', pressable: false, editable: true }),
        // The native side marks these two editable as well (`axRoleIsField`), and
        // a search box the model cannot name is a search box it has to hit by eye.
        element({ role: 'AXSearchField', title: 'Найти', pressable: false, editable: true }),
        element({ role: 'AXComboBox', title: 'Страна', pressable: false, editable: true })
      ]),
      null,
      area
    )

    expect(body(outline)).toHaveLength(4)
    expect(outline).toContain('поле «Поиск»')
    expect(outline).toContain('поле «Заметка»')
    expect(outline).toContain('поле поиска «Найти»')
    expect(outline).toContain('поле «Страна»')
  })

  it('drops an element with no visible name', () => {
    expect(formatOutline(probe([element({ title: '', description: '', value: '' })]), null, area))
      .toBeNull()
    expect(formatOutline(probe([element({ title: '   ' })]), null, area)).toBeNull()
  })

  it('returns null for an empty probe', () => {
    expect(formatOutline(probe([]), null, area)).toBeNull()
  })
})

describe('formatOutline: how a name is chosen', () => {
  it('prefers title, then description, then value', () => {
    expect(body(formatOutline(probe([element({ title: 'T', description: 'D', value: 'V' })]), null, area)))
      .toEqual(['  0.140 0.144  кнопка «T»'])
    expect(body(formatOutline(probe([element({ title: undefined, description: 'D', value: 'V' })]), null, area)))
      .toEqual(['  0.140 0.144  кнопка «D»'])
    expect(body(formatOutline(probe([element({ title: undefined, description: undefined, value: 'V' })]), null, area)))
      .toEqual(['  0.140 0.144  кнопка «V»'])
  })

  it('never uses the value of an editable as its name', () => {
    const outline = formatOutline(
      probe([
        element({
          role: 'AXTextField',
          title: undefined,
          editable: true,
          pressable: false,
          value: 'набранный текст'
        })
      ]),
      null,
      area
    )
    expect(outline).toBeNull()
  })

  it('collapses whitespace and trims', () => {
    expect(body(formatOutline(probe([element({ title: '  Экспорт \n  PDF  ' })]), null, area)))
      .toEqual(['  0.140 0.144  кнопка «Экспорт PDF»'])
  })

  it('truncates a long name to 46 characters with an ellipsis', () => {
    const long = 'я'.repeat(80)
    const line = body(formatOutline(probe([element({ title: long })]), null, area))[0]
    const name = line.slice(line.indexOf('«') + 1, line.indexOf('»'))
    expect(name).toHaveLength(46)
    expect(name.endsWith('…')).toBe(true)
    expect(name.slice(0, 45)).toBe('я'.repeat(45))
  })

  it('keeps a name of exactly 46 characters as it is', () => {
    const exact = 'я'.repeat(46)
    const line = body(formatOutline(probe([element({ title: exact })]), null, area))[0]
    expect(line).toContain(`«${exact}»`)
  })

  it('drops the role word for a role it does not know', () => {
    const line = body(formatOutline(probe([element({ role: 'AXUnknown' })]), null, area))[0]
    expect(line).toBe('  0.140 0.144  «Экспорт»')
  })

  it('drops the role word when the role is missing', () => {
    const line = body(formatOutline(probe([element({ role: undefined })]), null, area))[0]
    expect(line).toBe('  0.140 0.144  «Экспорт»')
  })
})

describe('formatOutline: order, dedup and the cap', () => {
  it('sorts into reading order: by row, then left to right', () => {
    const outline = formatOutline(
      probe([
        element({ title: 'второй', frame: { x: 300, y: 100, width: 50, height: 20 } }),
        element({ title: 'первый', frame: { x: 100, y: 100, width: 50, height: 20 } }),
        element({ title: 'ниже', frame: { x: 50, y: 300, width: 50, height: 20 } })
      ]),
      null,
      area
    )
    const names = body(outline).map((line) => line.slice(line.indexOf('«') + 1, line.indexOf('»')))
    expect(names).toEqual(['первый', 'второй', 'ниже'])
  })

  it('treats elements within 12 points of each other as the same row', () => {
    const outline = formatOutline(
      probe([
        element({ title: 'правее', frame: { x: 300, y: 100, width: 50, height: 20 } }),
        element({ title: 'левее', frame: { x: 100, y: 108, width: 50, height: 20 } })
      ]),
      null,
      area
    )
    const names = body(outline).map((line) => line.slice(line.indexOf('«') + 1, line.indexOf('»')))
    expect(names).toEqual(['левее', 'правее'])
  })

  it('dedupes the same name at the same rounded position', () => {
    const outline = formatOutline(
      probe([element(), element(), element({ title: 'другой' })]),
      null,
      area
    )
    expect(body(outline)).toHaveLength(2)
  })

  it('caps the list at 70 lines and counts the rest', () => {
    const many = Array.from({ length: 90 }, (_, index) =>
      element({
        title: `пункт ${index}`,
        frame: { x: 10, y: 10 + index * 8, width: 50, height: 4 }
      })
    )
    const outline = formatOutline(probe(many), null, area)

    expect(body(outline)).toHaveLength(70)
    expect(outline).toContain('  …и ещё 20')
  })

  it('does not add the remainder line when everything fit', () => {
    const outline = formatOutline(probe([element()]), null, area)
    expect(outline).not.toContain('…и ещё')
  })
})

describe('formatOutline: the header the model reads', () => {
  it('keeps the instruction block and the quoting rule verbatim', () => {
    const outline = formatOutline(probe([element()]), null, area) as string
    const header = outline.split('\n').slice(0, 9)

    expect(header).toEqual([
      '[Элементы активного окна]',
      'То, что сейчас можно нажать, с точными названиями. Если нужный пункт есть',
      'здесь — бери координаты из его строки, а название копируй в «…» как есть:',
      '  @click X Y left «Название»',
      'Это точнее, чем мерить по картинке: имя важнее координат, по нему клик',
      'ставится в центр элемента.',
      'Для рисунка используй @point circle X Y «Название» с тем же точным названием:',
      'приложение привяжет обводку к границам однозначно названного элемента.',
      ''
    ])
  })
})

describe('describeScreen', () => {
  it('asks the helper about the given pid', async () => {
    helperProbe.mockResolvedValue(probe([element()]))
    await describeScreen(42, null, area)
    expect(helperProbe).toHaveBeenCalledWith(42)
  })

  it('returns null when the probe failed', async () => {
    helperProbe.mockResolvedValue(null)
    expect(await describeScreen(42, null, area)).toBeNull()
  })

  it('returns null when the probe found nothing actionable', async () => {
    helperProbe.mockResolvedValue(probe([]))
    expect(await describeScreen(42, null, area)).toBeNull()
  })

  it('returns the rendered list on success', async () => {
    helperProbe.mockResolvedValue(probe([element()]))
    const outline = await describeScreen(42, null, area)
    expect(outline).toContain('кнопка «Экспорт»')
  })

  it('still probes and renders when the pid is null', async () => {
    helperProbe.mockResolvedValue(probe([element()]))
    expect(await describeScreen(null, null, area)).toContain('кнопка «Экспорт»')
    expect(helperProbe).toHaveBeenCalledWith(null)
  })
})
