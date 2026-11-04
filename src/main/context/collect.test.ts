import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { ActiveAppInfo } from '@shared/types'

const { getActiveApp, isExcluded } = vi.hoisted(() => ({
  getActiveApp: vi.fn(),
  isExcluded: vi.fn()
}))

vi.mock('./activeApp', () => ({ getActiveApp, isExcluded }))

const { readSelection } = vi.hoisted(() => ({ readSelection: vi.fn() }))

vi.mock('./selection', () => ({ readSelection }))

import { collectContext } from './collect'

const app: ActiveAppInfo = {
  bundleId: 'com.apple.Safari',
  name: 'Safari',
  pid: 512,
  windowTitle: 'Статья',
  windowId: 7,
  bounds: { x: 0, y: 25, width: 1440, height: 875 }
}

beforeEach(() => {
  getActiveApp.mockReset().mockResolvedValue(app)
  isExcluded.mockReset().mockReturnValue(false)
  readSelection.mockReset().mockResolvedValue(null)
})

describe('collectContext: the app', () => {
  it('puts the active app into the snapshot', async () => {
    const { snapshot } = await collectContext({ excludedApps: [], captureScreenshot: false })

    expect(snapshot.activeApp).toEqual(app)
    expect(snapshot.excluded).toBe(false)
    expect(snapshot.warnings).toEqual([])
  })

  it('warns when the active app cannot be determined', async () => {
    getActiveApp.mockResolvedValue(null)

    const { snapshot } = await collectContext({ excludedApps: [], captureScreenshot: false })

    expect(snapshot.activeApp).toBeNull()
    expect(snapshot.warnings).toContain('Не удалось определить активное приложение.')
  })

  it('never reads the selection when there is no active app', async () => {
    getActiveApp.mockResolvedValue(null)

    await collectContext({ excludedApps: [], captureScreenshot: true })

    expect(readSelection).not.toHaveBeenCalled()
  })

  it('always leaves the screenshot for the overlay to fill in', async () => {
    const { snapshot } = await collectContext({ excludedApps: [], captureScreenshot: true })

    expect(snapshot.screenshot).toBeNull()
  })

  it('reports how long collection took', async () => {
    const { snapshot } = await collectContext({ excludedApps: [], captureScreenshot: false })

    expect(typeof snapshot.collectedMs).toBe('number')
    expect(snapshot.collectedMs).toBeGreaterThanOrEqual(0)
  })
})

describe('collectContext: an excluded app', () => {
  beforeEach(() => {
    isExcluded.mockReturnValue(true)
  })

  it('warns and marks the snapshot as excluded', async () => {
    const { snapshot } = await collectContext({ excludedApps: ['com.apple.Safari'], captureScreenshot: true })

    expect(snapshot.excluded).toBe(true)
    expect(snapshot.warnings).toContain(
      'Приложение входит в список исключений — контекст не собирается.'
    )
  })

  it('does not read the selection or take a screenshot', async () => {
    const { snapshot, flags } = await collectContext({
      excludedApps: ['com.apple.Safari'],
      captureScreenshot: true
    })

    expect(readSelection).not.toHaveBeenCalled()
    expect(snapshot.selection).toBeNull()
    expect(flags).toEqual({ includeSelection: false, includeScreenshot: false })
    expect(snapshot.screenshotPending).toBe(false)
  })
})

describe('collectContext: the flags', () => {
  it('keeps a selection and drops the screenshot when text was selected', async () => {
    readSelection.mockResolvedValue({ text: 'выделено', truncated: false })

    const { snapshot, flags } = await collectContext({
      excludedApps: [],
      captureScreenshot: true
    })

    expect(snapshot.selection).toEqual({ text: 'выделено', truncated: false })
    expect(flags).toEqual({ includeSelection: true, includeScreenshot: false })
    // The screenshot chip stays honest even though nothing will be captured.
    expect(snapshot.screenshotPending).toBe(true)
  })

  it('takes a screenshot when nothing is selected and the user wants one', async () => {
    const { flags, snapshot } = await collectContext({ excludedApps: [], captureScreenshot: true })

    expect(flags).toEqual({ includeSelection: false, includeScreenshot: true })
    expect(snapshot.screenshotPending).toBe(true)
  })

  it('takes nothing when the user turned the screenshot off', async () => {
    const { flags, snapshot } = await collectContext({ excludedApps: [], captureScreenshot: false })

    expect(flags).toEqual({ includeSelection: false, includeScreenshot: false })
    expect(snapshot.screenshotPending).toBe(false)
  })

  it('swallows a failing selection read and treats it as no selection', async () => {
    readSelection.mockRejectedValue(new Error('pasteboard busy'))

    const { snapshot, flags } = await collectContext({ excludedApps: [], captureScreenshot: true })

    expect(snapshot.selection).toBeNull()
    expect(flags).toEqual({ includeSelection: false, includeScreenshot: true })
  })

  it('never captures a screenshot without an active app', async () => {
    getActiveApp.mockResolvedValue(null)

    const { flags, snapshot } = await collectContext({ excludedApps: [], captureScreenshot: true })

    expect(flags).toEqual({ includeSelection: false, includeScreenshot: false })
    expect(snapshot.screenshotPending).toBe(false)
  })
})
