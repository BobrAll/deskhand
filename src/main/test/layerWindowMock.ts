import type { ScreenRect } from '@shared/types'

/** One fake layer window, and everything the layer did to it. */
export interface FakeLayerWindow<Frame> {
  bounds: ScreenRect | null
  shown: number
  hidden: number
  destroyed: boolean
  sent: Frame[]
  loadHandlers: Record<string, () => void>
}

/** The windows a test has created, in creation order. */
export interface FakeLayerState<Frame> {
  windows: FakeLayerWindow<Frame>[]
}

/**
 * The `BrowserWindow` the layer tests run against.
 *
 * It records what the layer asked for instead of drawing anything: the bounds it
 * was placed on, how often it was shown or hidden, the frames sent to its page,
 * and whether it was destroyed. The page reports a finished load on the next
 * tick, as a real one does, so a test never has to fire it by hand.
 *
 * Shared by `agent/cursor.test.ts` and `agent/presentation.test.ts`: the two
 * layers differ in their policy, not in the window API they use.
 */
export function layerWindowClass<Frame>(state: FakeLayerState<Frame>) {
  return class FakeBrowserWindow {
    readonly webContents = {
      setWindowOpenHandler: (_handler: unknown): void => {
        // Part of the contract: the layer never opens a window of its own.
      },
      on: (_event: string, _handler: unknown): void => {
        // Part of the contract: the layer never navigates in place either.
      },
      once: (event: string, handler: () => void) => {
        this.entry.loadHandlers[event] = handler
        return this.webContents
      },
      send: (_channel: string, payload: Frame): void => {
        this.entry.sent.push(payload)
      }
    }
    readonly entry: FakeLayerWindow<Frame>

    constructor() {
      this.entry = {
        bounds: null,
        shown: 0,
        hidden: 0,
        destroyed: false,
        sent: [],
        loadHandlers: {}
      }
      state.windows.push(this.entry)
      // The page loads on the next tick, as a real one does.
      queueMicrotask(() => this.entry.loadHandlers['did-finish-load']?.())
    }

    loadURL(): void {
      // Not used: the dev-server branch is off in tests.
    }
    loadFile(): void {
      // Not used: the dev-server branch is off in tests.
    }
    setBounds(bounds: ScreenRect): void {
      this.entry.bounds = bounds
    }
    setAlwaysOnTop(): void {
      // Part of the contract: the layer sits above full-screen apps.
    }
    setVisibleOnAllWorkspaces(): void {
      // Part of the contract: the layer is visible across spaces.
    }
    on(event: string, handler: () => void): void {
      this.entry.loadHandlers[event] = handler
    }
    setIgnoreMouseEvents(): void {
      // Part of the contract: the layer never eats clicks.
    }
    setContentProtection(): void {
      // Part of the contract: the layer never ends up in a screenshot.
    }
    showInactive(): void {
      this.entry.shown += 1
    }
    hide(): void {
      this.entry.hidden += 1
    }
    isDestroyed(): boolean {
      return this.entry.destroyed
    }
    destroy(): void {
      this.entry.destroyed = true
    }
  }
}

/** The window the layer created last. */
export function lastLayerWindow<Frame>(state: FakeLayerState<Frame>): FakeLayerWindow<Frame> {
  return state.windows[state.windows.length - 1]
}
