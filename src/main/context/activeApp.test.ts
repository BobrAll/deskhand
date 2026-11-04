import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { ActiveAppInfo } from '@shared/types'

const { helperFront } = vi.hoisted(() => ({ helperFront: vi.fn() }))

vi.mock('../native/helper', () => ({ helperFront }))

import { getActiveApp, isExcluded } from './activeApp'

function front(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    bundleId: 'com.apple.Safari',
    name: 'Safari',
    pid: 512,
    windowId: 7,
    windowTitle: 'Статья',
    bounds: { x: 0, y: 25, width: 1440, height: 875 },
    accessibility: true,
    ...overrides
  }
}

function app(overrides: Partial<ActiveAppInfo> = {}): ActiveAppInfo {
  return {
    bundleId: 'com.apple.Safari',
    name: 'Safari',
    pid: 512,
    windowTitle: 'Статья',
    windowId: 7,
    bounds: { x: 0, y: 25, width: 1440, height: 875 },
    ...overrides
  }
}

beforeEach(() => {
  helperFront.mockReset()
})

describe('getActiveApp', () => {
  it('maps the frontmost app into the snapshot shape', async () => {
    helperFront.mockResolvedValue(front())

    expect(await getActiveApp()).toEqual(app())
  })

  it('drops the fields the snapshot does not carry', async () => {
    helperFront.mockResolvedValue(front())

    expect(await getActiveApp()).not.toHaveProperty('accessibility')
  })

  it('returns null when the frontmost app cannot be determined', async () => {
    helperFront.mockResolvedValue(null)

    expect(await getActiveApp()).toBeNull()
  })

  it('passes a missing window title and bounds through as null', async () => {
    helperFront.mockResolvedValue(
      front({ windowTitle: null, bounds: null, windowId: null, accessibility: false })
    )

    expect(await getActiveApp()).toEqual(
      app({ windowTitle: null, bounds: null, windowId: null })
    )
  })

  it('keeps a zero pid: it means "unknown", not "missing"', async () => {
    helperFront.mockResolvedValue(front({ pid: 0 }))

    expect((await getActiveApp())?.pid).toBe(0)
  })
})

describe('isExcluded', () => {
  const excluded = ['com.apple.Passwords', 'com.1password.1password']

  it('is false for a null app', () => {
    expect(isExcluded(null, excluded)).toBe(false)
  })

  it('is false for an app without a bundle id', () => {
    expect(isExcluded(app({ bundleId: '' }), excluded)).toBe(false)
  })

  it('is true when the bundle id is on the list', () => {
    expect(isExcluded(app({ bundleId: 'com.apple.Passwords' }), excluded)).toBe(true)
  })

  it('is false when the bundle id is not on the list', () => {
    expect(isExcluded(app({ bundleId: 'com.apple.Safari' }), excluded)).toBe(false)
  })

  it('is false for an empty list', () => {
    expect(isExcluded(app(), [])).toBe(false)
  })

  it('matches the bundle id exactly, not by name or prefix', () => {
    expect(isExcluded(app({ name: 'com.apple.Passwords' }), excluded)).toBe(false)
    expect(isExcluded(app({ bundleId: 'com.apple.Passwords.helper' }), excluded)).toBe(false)
  })
})
