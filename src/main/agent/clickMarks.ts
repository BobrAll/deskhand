import { nativeImage } from 'electron'
import type { AgentPlanStep, AxElementInfo, ScreenRect } from '@shared/types'
import type { ChatMessage } from '../llm/provider'
import { toFramePoint } from './geometry'
import { centerOf, nameTexts } from './targeting'

interface ClickMark {
  element: AxElementInfo & { frame: ScreenRect }
  box: ScreenRect
  badge: ScreenRect
}

const MAX_MARKS = 48
const BADGE_HEIGHT = 14
const DIGITS = [
  '111101101101111', '010110010010111', '111001111100111', '111001111001111', '101101111001001',
  '111100111001111', '111100111101111', '111001010010010', '111101111101111', '111101111001111'
]

function overlaps(a: ScreenRect, b: ScreenRect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
}

function inside(rect: ScreenRect, area: ScreenRect): boolean {
  return rect.x >= area.x && rect.y >= area.y &&
    rect.x + rect.width <= area.x + area.width && rect.y + rect.height <= area.y + area.height
}

/** Project the AX frame into the actual pixels of the compressed observation. */
export function clickMarks(
  elements: AxElementInfo[], area: ScreenRect, width: number, height: number
): ClickMark[] {
  if (area.width <= 0 || area.height <= 0) return []
  const image = { x: 0, y: 0, width, height }
  const projected = elements.flatMap((element) => {
    const frame = element.frame
    // Compact controls benefit most from exact grounding. Leave large regions
    // and text fields unobstructed so the model can read the screenshot.
    if (!element.pressable || element.editable || !frame || !inside(frame, area) ||
        frame.width > 140 || frame.height > 64) return []
    const x = Math.round((frame.x - area.x) * width / area.width)
    const y = Math.round((frame.y - area.y) * height / area.height)
    const box = {
      x, y,
      width: Math.round((frame.x + frame.width - area.x) * width / area.width) - x,
      height: Math.round((frame.y + frame.height - area.y) * height / area.height) - y
    }
    return box.width >= 6 && box.height >= 6 ? [{ element: { ...element, frame }, box }] : []
  }).sort((a, b) => a.box.width * a.box.height - b.box.width * b.box.height)

  const marks: ClickMark[] = []
  for (const { element, box } of projected) {
    if (marks.some((mark) => overlaps(mark.box, box))) continue
    const badgeWidth = marks.length < 9 ? 10 : 18
    const badge = [
      { x: box.x, y: box.y - BADGE_HEIGHT },
      { x: box.x, y: box.y + box.height },
      { x: box.x + box.width, y: box.y },
      { x: box.x - badgeWidth, y: box.y }
    ].map((point) => ({ ...point, width: badgeWidth, height: BADGE_HEIGHT }))
      .find((slot) => inside(slot, image) &&
        !projected.some((candidate) => overlaps(candidate.box, slot)) &&
        !marks.some((mark) => overlaps(mark.badge, slot)))
    if (!badge) continue
    marks.push({ element, box, badge })
    if (marks.length >= MAX_MARKS) break
  }
  return marks
}

function paintMarks(bitmap: Buffer, width: number, marks: ClickMark[]): void {
  const fill = (rect: ScreenRect, color: number): void => {
    for (let y = rect.y; y < rect.y + rect.height; y += 1) {
      for (let x = rect.x; x < rect.x + rect.width; x += 1) {
        bitmap.writeUInt32LE(color, (y * width + x) * 4)
      }
    }
  }

  for (const [index, { box, badge }] of marks.entries()) {
    const color = 0xff1ecfff
    fill({ ...box, height: 1 }, color)
    fill({ ...box, y: box.y + box.height - 1, height: 1 }, color)
    fill({ ...box, width: 1 }, color)
    fill({ ...box, x: box.x + box.width - 1, width: 1 }, color)
    fill(badge, 0xff191919)

    const digits = String(index + 1)
    for (const [offset, digit] of [...digits].entries()) {
      for (const [pixel, on] of [...DIGITS[Number(digit)]].entries()) {
        if (on === '0') continue
        fill({
          x: badge.x + 2 + offset * 8 + (pixel % 3) * 2,
          y: badge.y + 2 + Math.floor(pixel / 3) * 2,
          width: 2, height: 2
        }, 0xffffffff)
      }
    }
  }
}

export function markClickTargets(messages: ChatMessage[], area: ScreenRect, targets: AxElementInfo[]):
  { messages: ChatMessage[]; marks: ClickMark[] } | null {
  const user = messages.at(-1)
  const image = user?.parts.find((part) => part.type === 'image')
  if (user?.role !== 'user' || image?.type !== 'image') return null

  try {
    const original = nativeImage.createFromBuffer(Buffer.from(image.base64, 'base64'))
    if (original.isEmpty()) return null
    const { width, height } = original.getSize()
    const marks = clickMarks(targets, area, width, height)
    if (marks.length === 0) return null
    const bitmap = original.toBitmap()
    if (bitmap.length !== width * height * 4) return null
    paintMarks(bitmap, width, marks)
    const marked = nativeImage.createFromBitmap(bitmap, { width, height })
    if (marked.isEmpty()) return null
    const parts = user.parts.map((part) => part === image
      ? { type: 'image' as const, mimeType: 'image/png', base64: marked.toPNG().toString('base64') }
      : part)
    parts.push({
      type: 'text',
      text: [
        '[Метки на снимке]',
        'Номера у рамок обозначают элементы интерфейса. Для отмеченной цели используй @click #НОМЕР left «Цель».',
        'Номер относится к рамке рядом с ним. Выбери элемент по виду и позиции; для цели без метки используй координаты.',
        ...marks.map(({ element }, index) => `#${index + 1} ${(nameTexts(element)[0] ?? element.roleDescription ?? element.role).replace(/\s+/g, ' ').slice(0, 60)}`)
      ].join('\n')
    })
    return { messages: [...messages.slice(0, -1), { ...user, parts }], marks }
  } catch {
    // Grounding is optional when the screenshot cannot be decoded or marked.
    return null
  }
}

export function bindMarkedClicks(steps: AgentPlanStep[], marks: ClickMark[], area: ScreenRect | null): AgentPlanStep[] {
  if (!area) return steps
  return steps.map((step) => {
    const action = step.action
    if (action.kind !== 'click-marker') return step
    const mark = marks[action.marker - 1]
    if (!mark) return step
    return { ...step, action: {
      kind: 'click', at: toFramePoint(centerOf(mark.element.frame), area),
      button: action.button, label: action.label, observedTarget: mark.element
    } }
  })
}
