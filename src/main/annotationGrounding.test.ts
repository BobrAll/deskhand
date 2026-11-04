import { describe, expect, it } from 'vitest'
import type { Annotation, AxElementInfo, ScreenRect } from '@shared/types'
import { groundAnnotation } from './annotationGrounding'

const area: ScreenRect = { x: -1000, y: 50, width: 1000, height: 800 }
const target: AxElementInfo = {
  role: 'AXButton', title: 'Codex', pressable: true,
  frame: { x: -900, y: 150, width: 80, height: 32 }
}
const circle: Annotation = {
  kind: 'circle', label: 'codex', from: { x: 0.7, y: 0.7 }, to: { x: 0.8, y: 0.8 }
}

describe('groundAnnotation', () => {
  it('replaces a wrong visual estimate with exact bounds on an offset display', () => {
    expect(groundAnnotation(circle, [target], area)).toEqual({
      ...circle, from: { x: 0.1, y: 0.125 }, to: { x: 0.18, y: 0.165 }
    })
  })

  it('does not choose between identically named elements', () => {
    expect(groundAnnotation(circle, [target, { ...target, frame: {
      x: -700, y: 150, width: 80, height: 32
    } }], area)).toBe(circle)
  })

  it('does not treat a substring as a match', () => {
    expect(groundAnnotation(circle, [{ ...target, title: 'Open Codex' }], area)).toBe(circle)
  })

  it('leaves unnamed drawings and unavailable AX data alone', () => {
    expect(groundAnnotation(circle, [], area)).toBe(circle)
    const unnamed = { ...circle, label: undefined }
    expect(groundAnnotation(unnamed, [target], area)).toBe(unnamed)
  })

  it('does not bind a field to the text typed into it', () => {
    expect(groundAnnotation(circle, [{ ...target, title: undefined,
      editable: true, value: 'codex' }], area)).toBe(circle)
  })

  it('moves only the arrow tip to the element centre', () => {
    const arrow: Annotation = { ...circle, kind: 'arrow' }
    const result = groundAnnotation(arrow, [target], area)
    expect(result.from).toEqual(arrow.from)
    expect(result.to.x).toBeCloseTo(0.14)
    expect(result.to.y).toBeCloseTo(0.145)
  })

  it('places an underline along the bottom of the element', () => {
    expect(groundAnnotation({ ...circle, kind: 'underline' }, [target], area)).toMatchObject({
      from: { x: 0.1, y: 0.165 }, to: { x: 0.18, y: 0.165 }
    })
  })

  it('rejects a frame outside the screenshot', () => {
    expect(groundAnnotation(circle, [{ ...target, frame: {
      x: 100, y: 150, width: 80, height: 32
    } }], area)).toBe(circle)
  })
})
