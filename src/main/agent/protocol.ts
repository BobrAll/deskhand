/**
 * The agent half of the line protocol: how the model asks the machine to press
 * something.
 *
 * Drawing and acting share one wire format on purpose. Both are "side effects
 * the answer mentions", both are unreliable in the same way (a model invents
 * coordinates), and both have to be stripped from the text before it reaches the
 * card or the clipboard. One parser for both means one place where a stray
 * marker can leak into an answer.
 *
 * Grammar (tolerant — models drift, and a rejected line must never print):
 *
 *     @click 0.42 0.31 left «Экспорт»
 *     @click 0.42 0.31 double
 *     @move 0.5 0.5
 *     @type Готово, отправляю
 *     @key cmd+s
 *     @scroll 0 -420
 *     @drag 0.10 0.20 0.50 0.60
 *     @wait 600
 *     @done «Всё»
 *
 * Coordinates are normalised against the screenshot, exactly like `@point`.
 * Everything after `@type` is taken verbatim: it is text meant for a field, not
 * a list of tokens, so it may contain spaces, commas and quotes.
 *
 * The `«…»` part of `@click` is not decoration: it is the text the app looks the
 * element up by when the point turns out to be a few dozen pixels off, which is
 * the normal accuracy of a model looking at a downscaled screenshot. A plan
 * without it is still parsed, it is just aimed with the guess alone.
 *
 * No Electron or Node imports — this module is pure and testable on its own.
 */

import type { AgentAction, AgentClickButton, Point01 } from '@shared/types'

const MAX_WAIT_MS = 10_000

const BUTTONS: AgentClickButton[] = ['left', 'right', 'double']

export interface ParsedAction {
  action: AgentAction
  /** One line for the card: what the user is about to see happen. */
  label: string
}

function cleanLabel(raw: string): string | undefined {
  const label = raw
    .trim()
    .replace(/^[«"'(\[]+/, '')
    .replace(/[»"')\]]+$/, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!label) return undefined
  return label.length > 60 ? `${label.slice(0, 59)}…` : label
}

/** Splits "0.42 0.31 left «Экспорт»" into numbers, an optional button and a label. */
function readPoint(tokens: string[]): { point: Point01; rest: string[] } | null {
  const numbers: number[] = []
  let index = 0
  while (index < tokens.length && numbers.length < 2) {
    const value = Number(tokens[index].replace(',', '.'))
    if (!Number.isFinite(value)) break
    numbers.push(value)
    index += 1
  }
  if (numbers.length < 2) return null
  // Percentages by accident ("42 31") are a common model slip.
  const scaled = numbers.map((value) => (Math.abs(value) > 1.5 ? value / 100 : value))
  if (scaled.some((value) => value < 0 || value > 1)) return null
  return {
    point: { x: scaled[0], y: scaled[1] },
    rest: tokens.slice(index)
  }
}

/**
 * Parses one line. `null` means "not an action marker"; an empty array means the
 * marker was recognised but is unusable, and the caller must swallow the line
 * rather than show `@click …` to the user.
 */
export function parseAgentLine(line: string): ParsedAction[] | null {
  const trimmed = line.trim()
  if (!/^@(click|move|type|key|press|navigate|browser|scroll|drag|wait|done|finish|look)\b/i.test(trimmed)) return null

  const match = /^@([A-Za-z]+)\s*([\s\S]*)$/.exec(trimmed)
  if (!match) return null
  const command = match[1].toLowerCase()
  const body = match[2] ?? ''

  if (command === 'type') {
    // Verbatim: the rest of the line is the payload, quotes and commas included.
    const text = body.trim()
    if (!text) return []
    return [{ action: { kind: 'type', text }, label: `Печать: ${shorten(text)}` }]
  }

  if (command === 'key' || command === 'press') {
    const combo = body.trim()
    if (!combo) return []
    return [{ action: { kind: 'key', combo }, label: `Клавиши: ${combo}` }]
  }

  if (command === 'browser') {
    return body.trim() ? [] : [{ action: { kind: 'browser' }, label: 'Открыть браузер по умолчанию' }]
  }

  if (command === 'navigate') {
    const url = body.trim()
    if (!url || url.length > 2048 || /\s/.test(url)) return []
    return [{ action: { kind: 'navigate', url }, label: 'Открыть страницу в браузере' }]
  }

  if (command === 'wait') {
    const ms = Math.round(Number.parseFloat(body.trim()))
    if (!Number.isFinite(ms) || ms <= 0) return []
    return [{ action: { kind: 'wait', ms: Math.min(ms, MAX_WAIT_MS) }, label: 'Пауза' }]
  }

  if (command === 'done' || command === 'finish') {
    return [{ action: { kind: 'done', label: cleanLabel(body) }, label: 'Готово' }]
  }

  if (command === 'look') {
    return [{ action: { kind: 'look' }, label: 'Взгляну на результат' }]
  }

  const tokens = body.split(/[\s,;]+/).filter(Boolean)

  if (command === 'scroll') {
    // `@scroll DX DY`, the same x-then-y order as every other command here. One
    // number is read as the vertical amount, because that is what scrolling is
    // for and a model that writes `@scroll -400` means "up".
    const first = Number.parseFloat((tokens[0] ?? '').replace(',', '.'))
    const second = Number.parseFloat((tokens[1] ?? '').replace(',', '.'))
    if (!Number.isFinite(first)) return []
    const horizontal = tokens.length > 1 && Number.isFinite(second) ? first : 0
    const vertical = tokens.length > 1 && Number.isFinite(second) ? second : first
    const dx = Math.max(-2000, Math.min(2000, Math.round(horizontal)))
    const dy = Math.max(-2000, Math.min(2000, Math.round(vertical)))
    if (dx === 0 && dy === 0) return []
    const direction = dy > 0 ? 'вниз' : dy < 0 ? 'вверх' : 'вбок'
    return [
      {
        action: { kind: 'scroll', dx, dy },
        label: `Прокрутка ${direction}`
      }
    ]
  }

  if (command === 'drag') {
    const first = readPoint(tokens)
    if (!first) return []
    const second = readPoint(first.rest)
    if (!second) return []
    return [
      {
        action: { kind: 'drag', from: first.point, to: second.point },
        label: 'Перетаскивание'
      }
    ]
  }

  if (command === 'move') {
    const parsed = readPoint(tokens)
    if (!parsed) return []
    return [
      {
        action: { kind: 'move', at: parsed.point, label: cleanLabel(parsed.rest.join(' ')) },
        label: 'Наведение курсора'
      }
    ]
  }

  // `click`
  const marker = /^#([1-9]\d{0,2})$/.exec(tokens[0] ?? '')
  const parsed = marker ? null : readPoint(tokens)
  if (!marker && !parsed) return []
  const rest = marker ? tokens.slice(1) : (parsed?.rest ?? [])
  const buttonToken = rest[0]?.toLowerCase() ?? ''
  const button: AgentClickButton = (BUTTONS as string[]).includes(buttonToken)
    ? (buttonToken as AgentClickButton)
    : 'left'
  const label = cleanLabel(rest.slice((BUTTONS as string[]).includes(buttonToken) ? 1 : 0).join(' '))
  const what = button === 'right' ? 'Правый клик' : button === 'double' ? 'Двойной клик' : 'Клик'
  return [
    {
      action: parsed
        ? { kind: 'click', at: parsed.point, button, label }
        : { kind: 'click-marker', marker: Number(marker?.[1]), button, label },
      label: label ? `${what}: «${label}»` : what
    }
  ]
}

function shorten(text: string): string {
  const single = text.replace(/\s+/g, ' ').replace(/[«»]/g, '').trim()
  return single.length > 40 ? `${single.slice(0, 39)}…` : single
}
