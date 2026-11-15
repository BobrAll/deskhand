import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

interface WindowDouble {
  options: Record<string, unknown>
  destroyed: boolean
  show: ReturnType<typeof vi.fn>
  focus: ReturnType<typeof vi.fn>
  hide: ReturnType<typeof vi.fn>
  setFocusable: ReturnType<typeof vi.fn>
  webContents: {
    setWindowOpenHandler: ReturnType<typeof vi.fn>
    on: ReturnType<typeof vi.fn>
    send: ReturnType<typeof vi.fn>
    isLoadingMainFrame(): boolean
  }
  close(): void
  emit(event: string): boolean
}
const state = vi.hoisted(() => ({
  windows: [] as WindowDouble[],
  opened: [] as string[]
}))

vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  class Window extends EventEmitter {
    destroyed = false
    show = vi.fn()
    focus = vi.fn()
    hide = vi.fn()
    setFocusable = vi.fn()
    webContents = {
      setWindowOpenHandler: vi.fn(),
      on: vi.fn(),
      send: vi.fn(),
      isLoadingMainFrame: () => false
    }
    constructor(readonly options: Record<string, unknown>) {
      super()
      state.windows.push(this)
    }
    isDestroyed(): boolean {
      return this.destroyed
    }
    close(): void {
      const event = { preventDefault: vi.fn() }
      this.emit('close', event)
      if (!event.preventDefault.mock.calls.length) {
        this.destroyed = true
        this.emit('closed')
      }
    }
  }
  return {
    BrowserWindow: Window,
    app: { focus: vi.fn() },
    shell: {
      openExternal: (url: string) => {
        state.opened.push(url)
        return Promise.resolve()
      }
    }
  }
})
vi.mock('../pageLoad', () => ({ loadPage: vi.fn() }))

beforeEach(() => {
  vi.resetModules()
  state.windows = []
  state.opened = []
  vi.useFakeTimers()
})
afterEach(() => vi.useRealTimers())

const load = () => import('./settings')

describe('settings window lifecycle', () => {
  it('keeps the options and waits for ready-to-show before showing', async () => {
    const api = await load()
    api.openSettingsWindow()
    const win = state.windows[0]
    expect(win.options).toMatchObject({
      width: 980,
      height: 760,
      minWidth: 820,
      minHeight: 560,
      show: false,
      webPreferences: {
        preload: expect.stringContaining('/preload/index.js'),
        sandbox: false,
        contextIsolation: true,
        nodeIntegration: false
      }
    })
    expect(win.show).not.toHaveBeenCalled()
    win.emit('ready-to-show')
    expect(win.show).toHaveBeenCalledOnce()
  })

  it('reuses and focuses the live singleton', async () => {
    const api = await load()
    const first = api.openSettingsWindow()
    expect(api.openSettingsWindow()).toBe(first)
    expect(state.windows).toHaveLength(1)
    expect(state.windows[0].focus).toHaveBeenCalledOnce()
  })

  it('hands a fresh window its target through the next load', async () => {
    const api = await load()
    api.openSettingsWindow({ tab: 'provider', view: 'models' })
    expect(api.takeSettingsOpenTarget()).toEqual({ tab: 'provider', view: 'models' })
    // Taken once: a reload must not replay a navigation the user already made.
    expect(api.takeSettingsOpenTarget()).toBeNull()
  })

  it('sends a target straight to a window that is already open', async () => {
    const api = await load()
    api.openSettingsWindow()
    expect(api.takeSettingsOpenTarget()).toBeNull()
    api.openSettingsWindow({ tab: 'provider', view: 'models', focus: 'extraBody' })
    expect(state.windows[0].webContents.send).toHaveBeenCalledWith('settings:navigate', {
      tab: 'provider',
      view: 'models',
      focus: 'extraBody'
    })
  })

  it('waits in 80 ms steps for an in-flight write', async () => {
    const api = await load()
    api.openSettingsWindow()
    api.setSettingsHeld(true)
    api.closeSettingsWindow()
    expect(state.windows[0].hide).toHaveBeenCalledOnce()
    vi.advanceTimersByTime(80)
    expect(state.windows[0].destroyed).toBe(false)
    api.setSettingsHeld(false)
    vi.advanceTimersByTime(79)
    expect(state.windows[0].destroyed).toBe(false)
    vi.advanceTimersByTime(1)
    expect(state.windows[0].destroyed).toBe(true)
  })

  it('cancels a deferred close when settings is reopened', async () => {
    const api = await load()
    const win = api.openSettingsWindow()
    api.setSettingsHeld(true)
    api.closeSettingsWindow()
    expect(win.hide).toHaveBeenCalledOnce()

    expect(api.openSettingsWindow()).toBe(win)
    expect(win.show).toHaveBeenCalled()
    vi.advanceTimersByTime(1200)
    expect(state.windows[0].destroyed).toBe(false)

    api.setSettingsHeld(false)
    api.closeSettingsWindow()
    expect(state.windows[0].destroyed).toBe(true)
  })

  it('closes after the 1200 ms ceiling even if the renderer stays busy', async () => {
    const api = await load()
    api.openSettingsWindow()
    api.setSettingsHeld(true)
    state.windows[0].close()
    vi.advanceTimersByTime(1199)
    expect(state.windows[0].destroyed).toBe(false)
    vi.advanceTimersByTime(1)
    expect(state.windows[0].destroyed).toBe(true)
  })

  it('clears both the singleton and busy flag on closed', async () => {
    const api = await load()
    api.openSettingsWindow()
    api.setSettingsHeld(true)
    state.windows[0].emit('closed')
    api.openSettingsWindow()
    api.closeSettingsWindow()
    expect(state.windows).toHaveLength(2)
    expect(state.windows[1].destroyed).toBe(true)
  })

  it('tells the listener once when the settings window is destroyed', async () => {
    const api = await load()
    const closed = vi.fn()
    api.setSettingsWindowClosedHandler(closed)

    api.openSettingsWindow()
    api.closeSettingsWindow()
    api.closeSettingsWindow()

    expect(closed).toHaveBeenCalledOnce()
  })

  it('does not report the onboarding window as the settings window', async () => {
    const api = await load()
    const closed = vi.fn()
    api.setSettingsWindowClosedHandler(closed)

    api.openOnboardingWindow()
    api.closeOnboardingWindow()

    expect(closed).not.toHaveBeenCalled()
  })

  it('waits for the actual destruction before reporting the close', async () => {
    const api = await load()
    const closed = vi.fn()
    api.setSettingsWindowClosedHandler(closed)
    api.openSettingsWindow()
    api.setSettingsHeld(true)

    api.closeSettingsWindow()
    vi.advanceTimersByTime(80)
    expect(closed).not.toHaveBeenCalled()

    api.setSettingsHeld(false)
    vi.advanceTimersByTime(80)
    expect(closed).toHaveBeenCalledOnce()
  })

  it('keeps onboarding separate and returns settings first for activation', async () => {
    const api = await load()
    const onboarding = api.openOnboardingWindow()
    const settings = api.openSettingsWindow()
    expect(api.openOnboardingWindow()).toBe(onboarding)
    expect(api.openAppWindows()).toEqual([settings, onboarding])
    expect(state.windows[0].options).toMatchObject({ width: 760, height: 660, resizable: false })
    api.closeOnboardingWindow()
    expect(api.openAppWindows()).toEqual([settings])
  })

  it('parks every open app window during a keyboard hand-off', async () => {
    const api = await load()
    api.openSettingsWindow()
    api.openOnboardingWindow()

    api.setAppWindowsFocusable(false)
    expect(state.windows.map((win) => win.setFocusable.mock.lastCall?.[0])).toEqual([false, false])

    api.setAppWindowsFocusable(true)
    expect(state.windows.map((win) => win.setFocusable.mock.lastCall?.[0])).toEqual([true, true])
  })
})

describe('settings window link handling', () => {
  /** The handler the window installed for `target="_blank"` and friends. */
  function openHandler(win: WindowDouble): (details: { url: string }) => { action: string } {
    return win.webContents.setWindowOpenHandler.mock.calls[0][0]
  }

  it('opens a provider link from the onboarding wizard in the browser', async () => {
    const api = await load()
    api.openOnboardingWindow()

    const result = openHandler(state.windows[0])({
      url: 'https://platform.openai.com/api-keys'
    })

    expect(result).toEqual({ action: 'deny' })
    expect(state.opened).toEqual(['https://platform.openai.com/api-keys'])
  })

  it('keeps the same guard on the settings window', async () => {
    const api = await load()
    api.openSettingsWindow()

    expect(openHandler(state.windows[0])({ url: 'https://example.com' })).toEqual({
      action: 'deny'
    })
    expect(state.opened).toEqual(['https://example.com'])
  })

  it('installs the in-place navigation guard on both windows', async () => {
    const api = await load()
    api.openOnboardingWindow()
    api.openSettingsWindow()

    for (const win of state.windows) {
      expect(win.webContents.on).toHaveBeenCalledWith('will-navigate', expect.any(Function))
    }
  })
})
