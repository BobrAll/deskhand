import { describe, expect, it } from 'vitest'

import type { ActiveAppInfo } from '@shared/types'
import { sameObservedWindow } from './observation'

function window(overrides: Partial<Pick<ActiveAppInfo, 'pid' | 'windowId' | 'windowTitle' | 'bounds'>> = {}) {
  return {
    pid: 42,
    windowId: 7,
    windowTitle: 'Документ',
    bounds: { x: 0, y: 0, width: 800, height: 600 },
    ...overrides
  }
}

describe('sameObservedWindow', () => {
  it('accepts an unchanged window', () => {
    expect(sameObservedWindow(window(), window())).toBe(true)
  })

  it('rejects a different process, window or title', () => {
    expect(sameObservedWindow(window(), window({ pid: 43 }))).toBe(false)
    expect(sameObservedWindow(window(), window({ windowId: 8 }))).toBe(false)
    expect(sameObservedWindow(window(), window({ windowTitle: 'Другой' }))).toBe(false)
  })

  it('rejects a moved or resized window', () => {
    expect(sameObservedWindow(window(), window({ bounds: { x: 1, y: 0, width: 800, height: 600 } }))).toBe(false)
    expect(sameObservedWindow(window(), window({ bounds: { x: 0, y: 0, width: 801, height: 600 } }))).toBe(false)
  })

  it('rejects a missing reading, because a window that cannot be read is not the same window', () => {
    expect(sameObservedWindow(window(), null)).toBe(false)
  })

  /**
   * `windowId` is `null` for any application whose on-screen window the system
   * cannot single out — Chrome, when several of its windows share a rectangle.
   * Two readings that agree on everything else are the same window even though
   * neither could name it, and demanding a number there rejected the observation
   * of every such app.
   */
  it('accepts two readings that agree without a window number', () => {
    const unnumbered = { windowId: null }
    expect(sameObservedWindow(window(unnumbered), window(unnumbered))).toBe(true)
  })

  it('rejects one numbered reading against an unnumbered one', () => {
    expect(sameObservedWindow(window(), window({ windowId: null }))).toBe(false)
    expect(sameObservedWindow(window({ windowId: null }), window())).toBe(false)
  })

  it('treats two readings with no geometry as equal only when neither has any', () => {
    expect(sameObservedWindow(window({ bounds: null }), window({ bounds: null }))).toBe(true)
    expect(sameObservedWindow(window({ bounds: null }), window())).toBe(false)
  })
})
