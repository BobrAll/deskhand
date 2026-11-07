import { expect, it, vi } from 'vitest'
import type { AxElementInfo, ScreenRect } from '@shared/types'
import type { ChatMessage } from '../llm/provider'
import { bindMarkedClicks, clickMarks, markClickTargets } from './clickMarks'
import { parseAgentLine } from './protocol'

const nativeImage = vi.hoisted(() => ({ createFromBuffer: vi.fn(), createFromBitmap: vi.fn() }))
vi.mock('electron', () => ({ nativeImage }))

const area: ScreenRect = { x: -400, y: 50, width: 400, height: 300 }
const icon: AxElementInfo = {
  role: 'AXButton', pid: 42, pressable: true,
  frame: { x: -240, y: 150, width: 24, height: 24 }
}

it('maps a small unnamed control from a scaled screenshot to its exact screen centre', () => {
  const marks = clickMarks([icon, { ...icon }], area, 200, 150)
  expect(marks).toHaveLength(1)
  expect(marks[0].box).toEqual({ x: 80, y: 50, width: 12, height: 12 })
  const steps = parseAgentLine('@click #1 right «Параметры»') ?? []
  const [step] = bindMarkedClicks(steps, marks, area)
  expect(step.action).toEqual({
    kind: 'click', at: { x: 0.43, y: 112 / 300 }, button: 'right', label: 'Параметры',
    observedTarget: icon
  })
})

it('keeps a reference to a missing marker unresolved so it cannot become a click', () => {
  const steps = parseAgentLine('@click #2 left') ?? []
  expect(bindMarkedClicks(steps, clickMarks([icon], area, 200, 150), area)).toEqual(steps)
  expect(steps[0].action.kind).toBe('click-marker')
})

it('paints marks only into the screenshot sent to the model', () => {
  const bitmap = Buffer.alloc(200 * 150 * 4)
  nativeImage.createFromBuffer.mockReturnValue({
    isEmpty: () => false, getSize: () => ({ width: 200, height: 150 }), toBitmap: () => bitmap
  })
  nativeImage.createFromBitmap.mockReturnValue({ isEmpty: () => false, toPNG: () => Buffer.from('marked') })
  const messages: ChatMessage[] = [{
    role: 'user',
    parts: [{ type: 'image', mimeType: 'image/jpeg', base64: 'YQ==' }, { type: 'text', text: 'Click settings' }]
  }]
  const marked = markClickTargets(messages, area, [icon])
  expect(marked?.marks).toHaveLength(1)
  expect(marked?.messages[0].parts[0]).toMatchObject({ mimeType: 'image/png' })
  expect(marked?.messages[0].parts[2]).toMatchObject({ text: expect.stringContaining('#1 AXButton') })
  expect(messages[0].parts[0]).toMatchObject({ mimeType: 'image/jpeg', base64: 'YQ==' })
  expect(bitmap.readUInt32LE((50 * 200 + 80) * 4)).toBe(0xff1ecfff)
})
