import { describe, expect, it } from 'vitest'

import { parseAgentLine } from './protocol'

describe('parseAgentLine: marker recognition', () => {
  it('returns null for a line that is not an action marker', () => {
    expect(parseAgentLine('обычный текст')).toBeNull()
    expect(parseAgentLine('@point arrow 0.1 0.2 0.3 0.4')).toBeNull()
    expect(parseAgentLine('@username привет')).toBeNull()
    expect(parseAgentLine('')).toBeNull()
    expect(parseAgentLine('   ')).toBeNull()
    expect(parseAgentLine('текст @click 0.1 0.2')).toBeNull()
  })

  it('accepts every command, case-insensitively', () => {
    const lines: Array<[string, string]> = [
      ['@click 0.1 0.2', 'click'],
      ['@move 0.1 0.2', 'move'],
      ['@type привет', 'type'],
      ['@key cmd+s', 'key'],
      ['@press enter', 'key'],
      ['@scroll 0 -420', 'scroll'],
      ['@drag 0.1 0.2 0.3 0.4', 'drag'],
      ['@wait 600', 'wait'],
      ['@open Telegram', 'open'],
      ['@done «Всё»', 'done'],
      ['@finish', 'done'],
      ['@look', 'look']
    ]
    for (const [line, kind] of lines) {
      expect(parseAgentLine(line)?.[0].action.kind, line).toBe(kind)
    }
    expect(parseAgentLine('@CLICK 0.1 0.2')?.[0].action.kind).toBe('click')
  })

  it('does not match a command glued to a longer word', () => {
    expect(parseAgentLine('@clicker 0.1 0.2')).toBeNull()
    expect(parseAgentLine('@types привет')).toBeNull()
  })

  it('returns an empty array for a recognised but unusable marker', () => {
    expect(parseAgentLine('@click')).toEqual([])
    expect(parseAgentLine('@click abc')).toEqual([])
    expect(parseAgentLine('@type')).toEqual([])
  })
})

describe('parseAgentLine: @click', () => {
  it('reads coordinates, button and a «» label', () => {
    expect(parseAgentLine('@click 0.42 0.31 left «Экспорт»')).toEqual([
      {
        action: { kind: 'click', at: { x: 0.42, y: 0.31 }, button: 'left', label: 'Экспорт' },
        label: 'Клик: «Экспорт»'
      }
    ])
  })

  it('defaults the button to left when the token is missing', () => {
    expect(parseAgentLine('@click 0.42 0.31')).toEqual([
      { action: { kind: 'click', at: { x: 0.42, y: 0.31 }, button: 'left' }, label: 'Клик' }
    ])
  })

  it('defaults the button to left when the token is unknown, keeping it as the label', () => {
    expect(parseAgentLine('@click 0.1 0.2 middle «X»')).toEqual([
      {
        action: { kind: 'click', at: { x: 0.1, y: 0.2 }, button: 'left', label: 'middle «X' },
        label: 'Клик: «middle «X»'
      }
    ])
  })

  it('reads right and double, with their own card labels', () => {
    expect(parseAgentLine('@click 0.1 0.2 right')).toEqual([
      { action: { kind: 'click', at: { x: 0.1, y: 0.2 }, button: 'right' }, label: 'Правый клик' }
    ])
    expect(parseAgentLine('@click 0.1 0.2 double «Файл»')).toEqual([
      {
        action: { kind: 'click', at: { x: 0.1, y: 0.2 }, button: 'double', label: 'Файл' },
        label: 'Двойной клик: «Файл»'
      }
    ])
  })

  it('is case-insensitive for the button', () => {
    expect(parseAgentLine('@click 0.1 0.2 RIGHT')?.[0].action).toMatchObject({ button: 'right' })
  })

  it('scales percentage coordinates', () => {
    expect(parseAgentLine('@click 42 31')?.[0].action).toMatchObject({
      at: { x: 0.42, y: 0.31 }
    })
  })

  it('rejects points outside the observed frame', () => {
    expect(parseAgentLine('@click -2 3')).toEqual([])
    expect(parseAgentLine('@click 101 50')).toEqual([])
    expect(parseAgentLine('@click 0.4junk 0.5')).toEqual([])
  })

  it('rejects a click with fewer than two numbers', () => {
    expect(parseAgentLine('@click 0.1')).toEqual([])
    expect(parseAgentLine('@click тут 0.2')).toEqual([])
  })
})

describe('parseAgentLine: @move', () => {
  it('reads a point and an optional label', () => {
    expect(parseAgentLine('@move 0.5 0.5')).toEqual([
      { action: { kind: 'move', at: { x: 0.5, y: 0.5 } }, label: 'Наведение курсора' }
    ])
    expect(parseAgentLine('@move 0.5 0.5 «Сюда»')).toEqual([
      {
        action: { kind: 'move', at: { x: 0.5, y: 0.5 }, label: 'Сюда' },
        label: 'Наведение курсора'
      }
    ])
  })

  it('rejects a move without two numbers', () => {
    expect(parseAgentLine('@move')).toEqual([])
    expect(parseAgentLine('@move 0.5')).toEqual([])
  })
})

describe('parseAgentLine: @type', () => {
  it('takes the rest of the line verbatim, commas and quotes included', () => {
    expect(parseAgentLine('@type Готово, отправляю')).toEqual([
      {
        action: { kind: 'type', text: 'Готово, отправляю' },
        label: 'Печать: Готово, отправляю'
      }
    ])
    expect(parseAgentLine('@type Он сказал "привет", и ушёл')).toEqual([
      {
        action: { kind: 'type', text: 'Он сказал "привет", и ушёл' },
        label: 'Печать: Он сказал "привет", и ушёл'
      }
    ])
  })

  it('trims the payload but keeps inner whitespace', () => {
    expect(parseAgentLine('@type   два  пробела  ')?.[0].action).toEqual({
      kind: 'type',
      text: 'два  пробела'
    })
  })

  it('rejects an empty payload', () => {
    expect(parseAgentLine('@type')).toEqual([])
    expect(parseAgentLine('@type    ')).toEqual([])
  })

  it('preserves the full payload for plan validation', () => {
    const action = parseAgentLine(`@type ${'я'.repeat(5000)}`)?.[0].action
    expect(action).toMatchObject({ kind: 'type' })
    expect((action as { text: string }).text).toHaveLength(5000)
  })

  it('keeps a payload of exactly 4000 characters', () => {
    const action = parseAgentLine(`@type ${'я'.repeat(4000)}`)?.[0].action
    expect((action as { text: string }).text).toHaveLength(4000)
  })

  it('collapses whitespace and «» in the card label only', () => {
    // The action keeps the payload as typed; the card label is collapsed and cut.
    expect(parseAgentLine('@type  раз   два  ')?.[0].label).toBe('Печать: раз два')
    expect(parseAgentLine('@type  раз   два  ')?.[0].action).toEqual({
      kind: 'type',
      text: 'раз   два'
    })
  })

  it('shortens a long card label to 40 characters plus an ellipsis', () => {
    const parsed = parseAgentLine(`@type ${'я'.repeat(100)}`)

    expect(parsed?.[0].label).toBe(`Печать: ${'я'.repeat(39)}…`)
    expect(parsed?.[0].action).toEqual({ kind: 'type', text: 'я'.repeat(100) })
  })

  it('drops «» from the card label', () => {
    expect(parseAgentLine('@type «привет»')?.[0].label).toBe('Печать: привет')
  })
})

describe('parseAgentLine: @key and @press', () => {
  it('keeps the combo verbatim', () => {
    expect(parseAgentLine('@key cmd+s')).toEqual([
      { action: { kind: 'key', combo: 'cmd+s' }, label: 'Клавиши: cmd+s' }
    ])
    expect(parseAgentLine('@press enter')).toEqual([
      { action: { kind: 'key', combo: 'enter' }, label: 'Клавиши: enter' }
    ])
    expect(parseAgentLine('@key cmd+shift+t')?.[0].action).toEqual({
      kind: 'key',
      combo: 'cmd+shift+t'
    })
  })

  it('rejects an empty combo', () => {
    expect(parseAgentLine('@key')).toEqual([])
    expect(parseAgentLine('@press   ')).toEqual([])
  })
})

describe('parseAgentLine: @scroll', () => {
  it('reads a signed dx/dy pair', () => {
    expect(parseAgentLine('@scroll 0 -420')).toEqual([
      { action: { kind: 'scroll', dx: 0, dy: -420 }, label: 'Прокрутка вверх' }
    ])
    expect(parseAgentLine('@scroll 0 420')).toEqual([
      { action: { kind: 'scroll', dx: 0, dy: 420 }, label: 'Прокрутка вниз' }
    ])
    expect(parseAgentLine('@scroll 120 0')).toEqual([
      { action: { kind: 'scroll', dx: 120, dy: 0 }, label: 'Прокрутка вбок' }
    ])
  })

  it('reads a single number as the vertical amount', () => {
    expect(parseAgentLine('@scroll -400')?.[0].action).toEqual({ kind: 'scroll', dx: 0, dy: -400 })
  })

  it('clamps each axis to ±2000 and rounds', () => {
    expect(parseAgentLine('@scroll 99999 -99999')?.[0].action).toEqual({
      kind: 'scroll',
      dx: 2000,
      dy: -2000
    })
    expect(parseAgentLine('@scroll 10.6 20.4')?.[0].action).toEqual({
      kind: 'scroll',
      dx: 11,
      dy: 20
    })
  })

  it('rejects a zero scroll and garbage', () => {
    expect(parseAgentLine('@scroll 0 0')).toEqual([])
    expect(parseAgentLine('@scroll 0')).toEqual([])
    expect(parseAgentLine('@scroll abc')).toEqual([])
    expect(parseAgentLine('@scroll')).toEqual([])
  })

  it('treats a non-numeric second token as a single-number scroll', () => {
    expect(parseAgentLine('@scroll -400 вверх')?.[0].action).toEqual({
      kind: 'scroll',
      dx: 0,
      dy: -400
    })
  })
})

describe('parseAgentLine: @drag', () => {
  it('reads two points', () => {
    expect(parseAgentLine('@drag 0.10 0.20 0.50 0.60')).toEqual([
      {
        action: { kind: 'drag', from: { x: 0.1, y: 0.2 }, to: { x: 0.5, y: 0.6 } },
        label: 'Перетаскивание'
      }
    ])
  })

  it('rejects a drag without two points', () => {
    expect(parseAgentLine('@drag 0.1 0.2')).toEqual([])
    expect(parseAgentLine('@drag')).toEqual([])
    expect(parseAgentLine('@drag 0.1 0.2 тут 0.4')).toEqual([])
  })
})

describe('parseAgentLine: @wait', () => {
  it('reads milliseconds and rounds them', () => {
    expect(parseAgentLine('@wait 600')).toEqual([
      { action: { kind: 'wait', ms: 600 }, label: 'Пауза' }
    ])
    expect(parseAgentLine('@wait 600.6')?.[0].action).toEqual({ kind: 'wait', ms: 601 })
  })

  it('caps the wait at 10000 ms', () => {
    expect(parseAgentLine('@wait 20000')?.[0].action).toEqual({ kind: 'wait', ms: 10000 })
    expect(parseAgentLine('@wait 10000')?.[0].action).toEqual({ kind: 'wait', ms: 10000 })
  })

  it('rejects a non-positive or unparsable wait', () => {
    expect(parseAgentLine('@wait 0')).toEqual([])
    expect(parseAgentLine('@wait -5')).toEqual([])
    expect(parseAgentLine('@wait abc')).toEqual([])
    expect(parseAgentLine('@wait')).toEqual([])
  })
})

describe('parseAgentLine: @open', () => {
  /**
   * "Открой Telegram" used to be reachable only as a click on the Dock icon:
   * the plan had no way to say "start this application", so the model aimed at
   * a pixel and the run depended on the icon being visible. `@open` is the
   * direct form of the request and the system launches the app itself.
   */
  it('reads the application name and drops the quotes', () => {
    expect(parseAgentLine('@open Telegram')).toEqual([
      { action: { kind: 'open', name: 'Telegram' }, label: 'Открыть: Telegram' }
    ])
    expect(parseAgentLine('@open «Google Chrome»')?.[0].action).toEqual({ kind: 'open', name: 'Google Chrome' })
  })

  it('keeps a multi-word name intact', () => {
    expect(parseAgentLine('@open Системные настройки')?.[0].action).toEqual({
      kind: 'open', name: 'Системные настройки'
    })
  })

  it('is unusable without a name', () => {
    expect(parseAgentLine('@open')).toEqual([])
    expect(parseAgentLine('@open   ')).toEqual([])
  })
})

describe('parseAgentLine: @done / @finish / @look', () => {
  it('reads the done label', () => {
    expect(parseAgentLine('@done «Всё»')).toEqual([
      { action: { kind: 'done', label: 'Всё' }, label: 'Готово' }
    ])
    expect(parseAgentLine('@done')?.[0].action).toEqual({ kind: 'done', label: undefined })
  })

  it('treats finish as done', () => {
    expect(parseAgentLine('@finish')).toEqual([
      { action: { kind: 'done' }, label: 'Готово' }
    ])
  })

  it('ignores anything after look', () => {
    expect(parseAgentLine('@look')).toEqual([
      { action: { kind: 'look' }, label: 'Взгляну на результат' }
    ])
    expect(parseAgentLine('@look 0.5')?.[0].action).toEqual({ kind: 'look' })
  })
})

describe('parseAgentLine: labels', () => {
  it('strips one layer of quotes', () => {
    for (const wrapped of ['«Сюда»', '"Сюда"', "'Сюда'", '(Сюда)', '[Сюда]']) {
      expect(parseAgentLine(`@click 0.1 0.2 left ${wrapped}`)?.[0].action).toMatchObject({
        label: 'Сюда'
      })
    }
  })

  it('collapses whitespace', () => {
    expect(parseAgentLine('@click 0.1 0.2 left «нажми   сюда»')?.[0].action).toMatchObject({
      label: 'нажми сюда'
    })
  })

  it('drops a label that is only quotes', () => {
    expect(parseAgentLine('@click 0.1 0.2 left «»')?.[0].action).toMatchObject({
      label: undefined
    })
  })

  it('truncates a click label at 60 characters with an ellipsis', () => {
    const action = parseAgentLine(`@click 0.1 0.2 left ${'я'.repeat(100)}`)?.[0].action
    expect((action as { label: string }).label).toHaveLength(60)
    expect((action as { label: string }).label.endsWith('…')).toBe(true)
  })
})
