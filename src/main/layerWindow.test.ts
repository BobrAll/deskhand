/**
 * The two layer windows (`pointer.ts` and `agent/cursor.ts`) shared 20 of their
 * 23 window-option lines; `layerWindow.ts` is that intersection. These tests pin
 * the intersection *and* the three lines that must stay different, because a
 * silent unification is exactly the failure mode the extraction could introduce.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = {
  options: [] as Array<Record<string, unknown>>,
  calls: [] as string[],
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
      once: (): void => undefined
    }

    constructor(options: Record<string, unknown>) {
      state.options.push(options)
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
  state.opened = []
  state.handlers = []
  state.closedHandlers = []
  state.loaded = []
  delete process.env['ELECTRON_RENDERER_URL']
})

describe('createLayerWindow: the shared contract', () => {
  it('creates a frameless, transparent, unfocusable, taskbar-less layer', async () => {
    const { createLayerWindow } = await loadLayerWindow()
    createLayerWindow({ page: 'pointer', acceptFirstMouse: true })

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
    createLayerWindow({ page: 'pointer', acceptFirstMouse: true })

    expect(state.options[0]?.['webPreferences']).toEqual({
      preload: expect.stringContaining('preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    })
  })

  it('applies all four pieces of chrome to every layer', async () => {
    const { createLayerWindow } = await loadLayerWindow()
    createLayerWindow({ page: 'pointer', acceptFirstMouse: true })
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
    createLayerWindow({ page: 'pointer', acceptFirstMouse: true })
    createLayerWindow({ page: 'cursor', acceptFirstMouse: false })

    expect(state.loaded).toEqual([
      expect.stringContaining('/pointer/index.html'),
      expect.stringContaining('/cursor/index.html')
    ])
  })

  it('runs onClosed when the window closes, and wires nothing when omitted', async () => {
    const { createLayerWindow } = await loadLayerWindow()
    const closed = vi.fn()
    createLayerWindow({ page: 'pointer', acceptFirstMouse: true, onClosed: closed })
    createLayerWindow({ page: 'cursor', acceptFirstMouse: false })

    expect(state.closedHandlers).toHaveLength(1)
    state.closedHandlers[0]?.()
    expect(closed).toHaveBeenCalledTimes(1)
  })
})

describe('createLayerWindow: the differences stay parameters', () => {
  it('passes acceptFirstMouse through instead of unifying it', async () => {
    const { createLayerWindow } = await loadLayerWindow()
    createLayerWindow({ page: 'pointer', acceptFirstMouse: true })
    createLayerWindow({ page: 'cursor', acceptFirstMouse: false })

    expect(state.options[0]?.['acceptFirstMouse']).toBe(true)
    expect(state.options[1]?.['acceptFirstMouse']).toBe(false)
  })

  it('opens HTTPS:// only for the caseless layer', async () => {
    const { createLayerWindow } = await loadLayerWindow()
    createLayerWindow({ page: 'pointer', acceptFirstMouse: true })
    createLayerWindow({ page: 'cursor', acceptFirstMouse: false, caseless: true })

    const [sensitive, caseless] = state.handlers
    expect(sensitive?.({ url: 'HTTPS://example.com' })).toEqual({ action: 'deny' })
    expect(caseless?.({ url: 'HTTPS://example.com' })).toEqual({ action: 'deny' })
    expect(state.opened).toEqual(['HTTPS://example.com'])
  })

  it('never navigates in-window: every url is denied', async () => {
    const { createLayerWindow } = await loadLayerWindow()
    createLayerWindow({ page: 'pointer', acceptFirstMouse: true })

    for (const url of ['https://example.com', 'file:///etc/passwd', 'javascript:1']) {
      expect(state.handlers[0]?.({ url })).toEqual({ action: 'deny' })
    }
  })
})
