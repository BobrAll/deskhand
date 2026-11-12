import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ScreenRect } from '@shared/types'

interface WindowDouble {
  visible: boolean
  bounds: ScreenRect
  options: Record<string, unknown>
  emit(event: string): boolean
  showInactive: ReturnType<typeof vi.fn>
  show: ReturnType<typeof vi.fn>
  focus: ReturnType<typeof vi.fn>
  setVibrancy: ReturnType<typeof vi.fn>
}
const state = vi.hoisted(() => ({
  hidden: false, windows: [] as WindowDouble[], unhide: vi.fn(), focus: vi.fn(), vibrancy: vi.fn()
}))
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  class Window extends EventEmitter {
    visible = false
    bounds = { x: 0, y: 0, width: 112, height: 31 }
    options: Record<string, unknown> = {}
    webContents = {
      setWindowOpenHandler: vi.fn(),
      session: { setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn() }
    }
    show = vi.fn(() => { this.visible = true })
    showInactive = vi.fn(() => { this.visible = true })
    focus = vi.fn()
    setAlwaysOnTop = vi.fn()
    setVibrancy = state.vibrancy
    constructor(options: Record<string, unknown>) {
      super()
      this.options = options
      state.windows.push(this)
    }
    isDestroyed(): boolean { return false }
    isVisible(): boolean { return this.visible }
    getBounds(): ScreenRect { return this.bounds }
    setBounds(bounds: ScreenRect): void { this.bounds = bounds }
    hide(): void { this.visible = false }
  }
  return {
    BrowserWindow: Window,
    app: {
      isHidden: () => state.hidden,
      show: () => { state.hidden = false; state.unhide() },
      focus: state.focus
    },
    screen: {
      getCursorScreenPoint: () => ({ x: 300, y: 300 }),
      getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1440, height: 900 } })
    }
  }
})
vi.mock('../pageLoad', () => ({ loadPage: vi.fn() }))

beforeEach(() => {
  vi.resetModules()
  state.hidden = false
  state.windows = []
  state.unhide.mockClear()
  state.focus.mockClear()
  state.vibrancy.mockClear()
})

async function readyHost() {
  const { overlayHost } = await import('./index')
  overlayHost.prewarm()
  const win = state.windows[0]
  win.emit('ready-to-show')
  return { host: overlayHost, win }
}

describe('voice indicator visibility', () => {
  it('shows bars immediately without focusing a prewarmed window', async () => {
    const { host, win } = await readyHost()
    host.setVoice(true)
    host.showInactive(31, 80)
    expect(win.showInactive).toHaveBeenCalledOnce()
    expect(win.bounds.width).toBe(80)
    expect(win.focus).not.toHaveBeenCalled()
    expect(state.focus).not.toHaveBeenCalled()
  })

  it('raises the indicator even when the card is already logically visible', async () => {
    const { host, win } = await readyHost()
    host.showInactive(31)
    win.showInactive.mockClear()
    host.setVoice(true)
    host.showInactive(31, 80)
    expect(win.showInactive).toHaveBeenCalledOnce()
  })

  it('raises a new voice turn while the preceding turn still owns the voice chrome', async () => {
    const { host, win } = await readyHost()
    host.setVoice(true)
    host.showInactive(31, 80)
    win.showInactive.mockClear()
    state.vibrancy.mockClear()
    host.setVoice(true)
    host.showInactive(31, 80)
    expect(win.showInactive).toHaveBeenCalledOnce()
    expect(state.vibrancy).not.toHaveBeenCalled()
  })

  it('unhides the application without taking keyboard focus', async () => {
    const { host, win } = await readyHost()
    host.showInactive(31)
    state.hidden = true
    win.showInactive.mockClear()
    host.showInactive(31)
    expect(state.unhide).toHaveBeenCalledOnce()
    expect(win.showInactive).toHaveBeenCalledOnce()
    expect(win.focus).not.toHaveBeenCalled()
    expect(state.focus).not.toHaveBeenCalled()
  })

  it('repairs visibility changed outside the host', async () => {
    const { host, win } = await readyHost()
    host.showInactive(31)
    win.visible = false
    win.showInactive.mockClear()
    host.showInactive(31)
    expect(win.showInactive).toHaveBeenCalledOnce()
  })

  it('waits for the first paint before showing newly created bars', async () => {
    const { overlayHost } = await import('./index')
    overlayHost.setVoice(true)
    overlayHost.showInactive(31, 80)
    const win = state.windows[0]
    expect(win).toBeDefined()
    expect(win.showInactive).not.toHaveBeenCalled()
    win.emit('ready-to-show')
    expect(win.showInactive).toHaveBeenCalledOnce()
    expect(win.bounds.width).toBe(80)
    expect(state.vibrancy).toHaveBeenLastCalledWith(null)
  })
})

describe('card vibrancy', () => {
  it('creates a rounded window whose vibrancy is clipped to the card', async () => {
    const { win } = await readyHost()
    expect(win.options.roundedCorners).toBe(true)
    expect(win.options.vibrancy).toBe('under-window')
    expect(win.options.visualEffectState).toBe('active')
  })

  it('clears the blur for annotations and restores it when they are removed', async () => {
    const { host } = await readyHost()
    expect(state.vibrancy).toHaveBeenLastCalledWith('under-window')

    host.setDrawing(true)
    expect(state.vibrancy).toHaveBeenLastCalledWith(null)

    host.setDrawing(false)
    expect(state.vibrancy).toHaveBeenLastCalledWith('under-window')
  })

  it('keeps the blur off while a voice turn is still running', async () => {
    const { host } = await readyHost()

    host.setVoice(true)
    expect(state.vibrancy).toHaveBeenLastCalledWith(null)

    host.setDrawing(true)
    host.setDrawing(false)
    expect(state.vibrancy).toHaveBeenLastCalledWith(null)

    host.setVoice(false)
    expect(state.vibrancy).toHaveBeenLastCalledWith('under-window')
  })
})
