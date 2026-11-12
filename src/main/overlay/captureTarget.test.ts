import { describe, expect, it } from 'vitest'
import type { ActiveAppInfo } from '@shared/types'
import { captureTargetFor } from './captureTarget'

const SAFARI: ActiveAppInfo = {
  bundleId: 'com.apple.Safari',
  name: 'Safari',
  pid: 42,
  windowTitle: 'Start',
  windowId: 7,
  bounds: { x: 10, y: 20, width: 800, height: 600 }
}

const PASSWORDS: ActiveAppInfo = {
  bundleId: 'com.apple.Passwords',
  name: 'Passwords',
  pid: 99,
  windowTitle: 'Passwords',
  windowId: 11,
  bounds: { x: 100, y: 100, width: 640, height: 480 }
}

describe('captureTargetFor: no excluded apps', () => {
  it('asks for the whole display as before', () => {
    expect(captureTargetFor({ observed: SAFARI, remembered: null, excludedApps: [] })).toEqual({
      windowId: 7,
      bounds: SAFARI.bounds,
      fullDisplay: true
    })
  })
})

describe('captureTargetFor: with excluded apps', () => {
  it('captures only the observed window and never falls back to the screen', () => {
    expect(captureTargetFor({
      observed: SAFARI,
      remembered: null,
      excludedApps: [PASSWORDS.bundleId]
    })).toEqual({
      windowId: 7,
      bounds: SAFARI.bounds,
      fullDisplay: false,
      allowFullScreenFallback: false
    })
  })

  it('uses the remembered window when the card itself is in front', () => {
    expect(captureTargetFor({
      observed: null,
      remembered: SAFARI,
      excludedApps: [PASSWORDS.bundleId]
    })).toEqual({
      windowId: 7,
      bounds: SAFARI.bounds,
      fullDisplay: false,
      allowFullScreenFallback: false
    })
  })

  it('refuses a window that is on the exclusion list now', () => {
    expect(captureTargetFor({
      observed: PASSWORDS,
      remembered: SAFARI,
      excludedApps: [PASSWORDS.bundleId]
    })).toBeNull()
  })

  it('refuses the remembered window when nothing can be observed', () => {
    expect(captureTargetFor({
      observed: null,
      remembered: PASSWORDS,
      excludedApps: [PASSWORDS.bundleId]
    })).toBeNull()
  })
})
