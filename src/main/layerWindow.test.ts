/**
 * The two layer windows (`drawing.ts` and `agent/cursor.ts`) shared 20 of their
 * 23 window-option lines; `layerWindow.ts` is that intersection. These tests pin
 * the intersection *and* the three lines that must stay different, because a
 * silent unification is exactly the failure mode the extraction could introduce.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { BrowserWindow } from 'electron'
import type { ScreenRect } from '@shared/types'

const state = {
  options: [] as Array<Record<string, unknown>>,
  calls: [] as string[],
  bounds: [] as ScreenRect[],
  opened: [] as string[],
  handlers: [] as Array<(details: { url: string }) => { action: string }>,
  closedHandlers: [] as Array<() => void>,
  loaded: [] as string[]
}

vi.mock('electron', () => {
  class FakeBrowserWindow {
    readonly webContents = {
      setWindowOpenHandler: (
        handler: (details: { url: string }) => { action: string }
      ): void => {
        state.handlers.push(handler)
      },
      on: (): void => undefined,
      once: (): void => undefined
    }

    constructor(options: Record<string, unknown>) {
      state.options.push(options)
    }
    setBounds(bounds: ScreenRect): void {
      state.bounds.push(bounds)
    }
    setIgnoreMouseEvents(): void {
      state.calls.push('setIgnoreMouseEvents')
    }
    setAlwaysOnTop(): void {
      state.calls.push('setAlwaysOnTop')
    }
    setVisibleOnAllWorkspaces(): void {
      state.calls.push('setVisibleOnAllWorkspaces')
    }
    setContentProtection(): void {
      state.calls.push('setContentProtection')
    }
    on(event: string, handler: () => void): void {
      if (event === 'closed') state.closedHandlers.push(handler)
    }
    loadFile(path: string): void {
      state.loaded.push(path)
    }
    loadURL(url: string): void {
      state.loaded.push(url)
    }
  }

  return {
    BrowserWindow: FakeBrowserWindow,
    shell: {
      openExternal: async (url: string) => {
        state.opened.push(url)
      }
    }
  }
})

async function loadLayerWindow(): Promise<typeof import('./layerWindow')> {
  vi.resetModules()
  return import('./layerWindow')
}

beforeEach(() => {
  state.options = []
  state.calls = []
  state.bounds = []
  state.opened = []
  state.handlers = []
  state.closedHandlers = []
  state.loaded = []
  delete process.env['ELECTRON_RENDERER_URL']
})

/** A window the shared placement helpers can move. */
function fakeWindow(): BrowserWindow {
  return new BrowserWindow()
}

describe('createLayerWindow: the shared contract', () => {
  it('creates a frameless, transparent, unfocusable, taskbar-less layer', async () => {
    const { createLayerWindow } = await loadLayerWindow()
    createLayerWindow({ page: 'drawing', acceptFirstMouse: true })

    expect(state.options[0]).toMatchObject({
      show: false,
      frame: false,
      transparent: true,
      hasShadow: false,
      resizable: false,
      movable: false,
      focusable: false,
      skipTaskbar: true,
      roundedCorners: false
    })
  })

  it('keeps webPreferences exactly as both callers had them', async () => {
    const { createLayerWindow } = await loadLayerWindow()
    createLayerWindow({ page: 'drawing', acceptFirstMouse: true })

    expect(state.options[0]?.['webPreferences']).toEqual({
      preload: expect.stringContaining('preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    })
  })

  it('applies all four pieces of chrome to every layer', async () => {
    const { createLayerWindow } = await loadLayerWindow()
    createLayerWindow({ page: 'drawing', acceptFirstMouse: true })
    createLayerWindow({ page: 'cursor', acceptFirstMouse: false })

    expect(state.calls).toEqual([
      'setIgnoreMouseEvents',
      'setAlwaysOnTop',
      'setVisibleOnAllWorkspaces',
      'setContentProtection',
      'setIgnoreMouseEvents',
      'setAlwaysOnTop',
      'setVisibleOnAllWorkspaces',
      'setContentProtection'
    ])
  })

  it('loads the page it was given, and only that page', async () => {
    const { createLayerWindow } = await loadLayerWindow()
    createLayerWindow({ page: 'drawing', acceptFirstMouse: true })
    createLayerWindow({ page: 'cursor', acceptFirstMouse: false })

    expect(state.loaded).toEqual([
      expect.stringContaining("/drawing/index.html"),
      expect.stringContaining('/cursor/index.html')
    ])
  })

  it('runs onClosed when the window closes, and wires nothing when omitted', async () => {
    const { createLayerWindow } = await loadLayerWindow()
    const closed = vi.fn()
    createLayerWindow({ page: 'drawing', acceptFirstMouse: true, onClosed: closed })
    createLayerWindow({ page: 'cursor', acceptFirstMouse: false })

    expect(state.closedHandlers).toHaveLength(1)
    state.closedHandlers[0]?.()
    expect(closed).toHaveBeenCalledTimes(1)
  })
})

describe('placeLayer: where a layer sits', () => {
  it('does not move a layer that is already there', async () => {
    const { placeLayer } = await loadLayerWindow()
    const win = fakeWindow()
    const area: ScreenRect = { x: 0, y: 0, width: 1440, height: 900 }

    const first = placeLayer(win, null, area)
    const second = placeLayer(win, first.placedOn, area)

    expect(first).toEqual({ placedOn: area, moved: true })
    expect(second).toEqual({ placedOn: area, moved: false })
    expect(state.bounds).toHaveLength(1)
  })

  it('rounds the drawing layer before comparing and applying', async () => {
    const { placeLayer } = await loadLayerWindow()
    const win = fakeWindow()
    const area: ScreenRect = { x: 100.4, y: 199.6, width: 800.2, height: 600 }

    const first = placeLayer(win, null, area, true)

    expect(first.placedOn).toEqual({ x: 100, y: 200, width: 800, height: 600 })
    expect(state.bounds).toEqual([{ x: 100, y: 200, width: 800, height: 600 }])
    // The same rectangle, given again, is the same place.
    expect(placeLayer(win, first.placedOn, area, true).moved).toBe(false)
    expect(state.bounds).toHaveLength(1)
  })

  it('leaves the agent layers’ bounds as they were given', async () => {
    const { placeLayer } = await loadLayerWindow()
    const win = fakeWindow()
    const area: ScreenRect = { x: 100.4, y: 199.6, width: 800.2, height: 600 }

    const first = placeLayer(win, null, area)

    expect(first.placedOn).toEqual(area)
    expect(state.bounds).toEqual([area])
    // A fractional change is a move: nothing is rounded away.
    expect(placeLayer(win, first.placedOn, { ...area, x: 100.5 }).moved).toBe(true)
  })
})

describe('sameScreenRect', () => {
  it('is false until the layer has been placed', async () => {
    const { sameScreenRect } = await loadLayerWindow()

    expect(sameScreenRect(null, { x: 0, y: 0, width: 1, height: 1 })).toBe(false)
  })

  it('compares exactly, or in whole points when asked to round', async () => {
    const { sameScreenRect } = await loadLayerWindow()
    const placed: ScreenRect = { x: 100, y: 200, width: 800, height: 600 }

    expect(sameScreenRect(placed, { ...placed, x: 100.4 })).toBe(false)
    expect(sameScreenRect(placed, { ...placed, x: 100.4 }, true)).toBe(true)
  })
})

describe('createLayerWindow: the differences stay parameters', () => {
  it('passes acceptFirstMouse through instead of unifying it', async () => {
    const { createLayerWindow } = await loadLayerWindow()
    createLayerWindow({ page: 'drawing', acceptFirstMouse: true })
    createLayerWindow({ page: 'cursor', acceptFirstMouse: false })

    expect(state.options[0]?.['acceptFirstMouse']).toBe(true)
    expect(state.options[1]?.['acceptFirstMouse']).toBe(false)
  })

  it('opens HTTPS:// only for the case-insensitive layer', async () => {
    const { createLayerWindow } = await loadLayerWindow()
    createLayerWindow({ page: 'drawing', acceptFirstMouse: true })
    createLayerWindow({
      page: 'cursor',
      acceptFirstMouse: false,
      matchSchemeCaseInsensitively: true
    })

    const [sensitive, caseInsensitive] = state.handlers
    expect(sensitive?.({ url: 'HTTPS://example.com' })).toEqual({ action: 'deny' })
    expect(caseInsensitive?.({ url: 'HTTPS://example.com' })).toEqual({ action: 'deny' })
    expect(state.opened).toEqual(['HTTPS://example.com'])
  })

  it('never navigates in-window: every url is denied', async () => {
    const { createLayerWindow } = await loadLayerWindow()
    createLayerWindow({ page: 'drawing', acceptFirstMouse: true })

    for (const url of ['https://example.com', 'file:///etc/passwd', 'javascript:1']) {
      expect(state.handlers[0]?.({ url })).toEqual({ action: 'deny' })
    }
  })
})
