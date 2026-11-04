import { describe, expect, it } from 'vitest'
import type { AgentPlanStep, ScreenshotInfo } from '@shared/types'
import { ProgressGuard } from './progress'

const shot: ScreenshotInfo = {
  dataUrl: 'data:image/png;base64,abc', width: 1000, height: 800, bytes: 3,
  capturedAt: 1, fullScreen: true, area: { x: 0, y: 0, width: 1000, height: 800 }
}
const steps: AgentPlanStep[] = [{ label: 'Open', action: { kind: 'key', combo: 'cmd+t' } }]

describe('per-turn progress memory', () => {
  it('blocks repeated mutations even after an intervening different action', () => {
    const guard = new ProgressGuard()
    expect(guard.allow(steps, shot)).toBe(true)
    expect(guard.allow([{ label: 'Escape', action: { kind: 'key', combo: 'esc' } }], shot)).toBe(true)
    expect(guard.allow(steps, { ...shot, capturedAt: 20 })).toBe(false)
    expect(new ProgressGuard().allow(steps, shot)).toBe(true)
  })

  it('allows the same action when the frame or its screen mapping changes', () => {
    const guard = new ProgressGuard()
    expect(guard.allow(steps, shot)).toBe(true)
    expect(guard.allow(steps, { ...shot, dataUrl: 'data:image/png;base64,changed' })).toBe(true)
    expect(guard.allow(steps, { ...shot, area: { x: 1000, y: 0, width: 1000, height: 800 } })).toBe(true)
  })

  it('allows waiting for loading and claiming a visible result without further input', () => {
    const guard = new ProgressGuard()
    const passive: AgentPlanStep[] = [{ label: 'Wait', action: { kind: 'wait', ms: 500 } }]
    expect(guard.allow(passive, shot)).toBe(true)
    expect(guard.allow(passive, shot)).toBe(true)
  })
})
