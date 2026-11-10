/**
 * The virtual pointer, as a contract rather than a screenshot.
 *
 * The point of this module is that it is *only* a picture: it receives an
 * action, paints it, and returns. So the tests pin three things and no more —
 * that nothing is created until an action arrives, that the frame carries the
 * action's geometry in the layer's own coordinates, and that the window is
 * hidden again without anyone waiting for it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AgentEvent, AgentPointerFrame, AgentPresentation, ScreenRect } from '@shared/types'

const state = vi.hoisted(() => ({
  cursor: { x: 500, y: 400 },
  display: { x: 0, y: 0, width: 1440, height: 900 },
  windows: [] as Array<{
    bounds: ScreenRect | null
    shown: number
    hidden: number
    destroyed: boolean
    sent: AgentPointerFrame[]
    loadHandlers: Record<string, () => void>
  }>
}))

vi.mock('electron', () => ({
  BrowserWindow: class {
    readonly webContents = {
      setWindowOpenHandler: (_handler: unknown) => {
        // This layer never opens anything.
      },
      once: (event: string, handler: () => void) => {
        this.entry.loadHandlers[event] = handler
        return this.webContents
      },
      send: (_channel: string, payload: AgentPointerFrame) => {
        this.entry.sent.push(payload)
      }
    }
    readonly entry: {
      bounds: ScreenRect | null
      shown: number
      hidden: number
      destroyed: boolean
      sent: AgentPointerFrame[]
      loadHandlers: Record<string, () => void>
    }

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
  },
  screen: {
    getCursorScreenPoint: () => state.cursor,
    getDisplayNearestPoint: (point: { x: number; y: number }) => {
      const inMain =
        point.x >= state.display.x &&
        point.x <= state.display.x + state.display.width &&
        point.y >= state.display.y &&
        point.y <= state.display.y + state.display.height
      // The second display is the one the tests move to, at -1920.
      return { bounds: inMain ? state.display : { x: -1920, y: 0, width: 1920, height: 1080 } }
    }
  },
  shell: {
    openExternal: async () => undefined
  }
}))

type PresentationModule = typeof import('./presentation')

let layer: PresentationModule

async function load(): Promise<PresentationModule> {
  vi.resetModules()
  return import('./presentation')
}

function action(overrides: Partial<AgentPresentation> = {}): AgentPresentation {
  return { tool: 'click', gesture: 'click', app: 'Safari', point: { x: 120, y: 300 }, ...overrides }
}

function phase(value: AgentEvent['phase']): AgentEvent {
  return { phase: value, step: 0, total: 0, label: '' }
}

/** Lets the pending promise chain of `paint()` settle. */
async function settle(): Promise<void> {
  for (let index = 0; index < 5; index += 1) await Promise.resolve()
  await vi.advanceTimersByTimeAsync(0)
  for (let index = 0; index < 5; index += 1) await Promise.resolve()
}

function win(): (typeof state.windows)[number] {
  return state.windows[state.windows.length - 1]
}

beforeEach(async () => {
  state.cursor = { x: 500, y: 400 }
  state.display = { x: 0, y: 0, width: 1440, height: 900 }
  state.windows = []
  vi.useFakeTimers({
    toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval']
  })
  layer = await load()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('presentAgentAction: painting an action', () => {
  it('creates nothing until an action arrives', () => {
    // The layer is a consequence of an action, not a fixture of the app: a run
    // that never acts must not pay for a window.
    expect(state.windows).toHaveLength(0)
  })

  it('places the layer over the display and sends the point in its coordinates', async () => {
    layer.presentAgentAction(action())
    await settle()

    expect(state.windows).toHaveLength(1)
    expect(win().bounds).toEqual({ x: 0, y: 0, width: 1440, height: 900 })
    expect(win().sent.at(-1)).toEqual({
      visible: true,
      idle: false,
      point: { x: 120, y: 300 },
      gesture: 'click',
      // The first frame starts where the real pointer is, so the arrow does not
      // appear out of nowhere.
      from: { x: 500, y: 400 }
    })
  })

  it('shows without taking focus', async () => {
    layer.presentAgentAction(action())
    await settle()

    expect(win().shown).toBe(1)
  })

  it('carries the element frame in the same coordinates as the point', async () => {
    layer.presentAgentAction(action({
      target: { x: 100, y: 290, width: 40, height: 20 }
    }))
    await settle()

    expect(win().sent.at(-1)?.target).toEqual({ x: 100, y: 290, width: 40, height: 20 })
  })

  it('travels from the previous target on a normal step', async () => {
    layer.presentAgentAction(action())
    await settle()
    layer.presentAgentAction(action({ point: { x: 700, y: 500 } }))
    await settle()

    expect(win().sent.at(-1)).toMatchObject({ point: { x: 700, y: 500 } })
    expect(win().sent.at(-1)?.from).toBeUndefined()
  })

  it('aims at the middle of the window when the call has no element', async () => {
    // A key press or a scroll with no element is aimed at the window, not at an
    // invented pixel.
    layer.presentAgentAction(action({
      tool: 'press_key',
      gesture: 'key',
      point: undefined,
      window: { x: 100, y: 100, width: 400, height: 300 }
    }))
    await settle()

    expect(win().sent.at(-1)?.point).toEqual({ x: 300, y: 250 })
  })

  it('draws nothing when there is no geometry to point at', async () => {
    layer.presentAgentAction(action({ point: undefined }))
    await settle()

    expect(state.windows).toHaveLength(0)
  })

  it('moves the layer to the display the target lives on', async () => {
    layer.presentAgentAction(action())
    await settle()
    layer.presentAgentAction(action({ point: { x: -1000, y: 200 } }))
    await settle()

    expect(win().bounds).toEqual({ x: -1920, y: 0, width: 1920, height: 1080 })
    expect(win().sent.at(-1)).toMatchObject({ point: { x: 920, y: 200 } })
    // The layer jumped displays, so the arrow enters from where it was instead
    // of sliding across a screen it is no longer over. The old target is off the
    // new display, so it is clamped to the edge it would have entered from.
    expect(win().sent.at(-1)?.from).toEqual({ x: 1920, y: 300 })
  })

  it('reuses one window for a whole batch', async () => {
    layer.presentAgentAction(action())
    await settle()
    layer.presentAgentAction(action({ point: { x: 200, y: 200 } }))
    await settle()
    layer.presentAgentAction(action({ point: { x: 300, y: 400 } }))
    await settle()

    expect(state.windows).toHaveLength(1)
    expect(win().shown).toBe(1)
  })
})

describe('showAgentPointer: present for the whole run', () => {
  it('appears before the first action, at the real pointer', async () => {
    layer.showAgentPointer()
    await settle()

    expect(state.windows).toHaveLength(1)
    expect(win().shown).toBe(1)
    expect(win().sent.at(-1)).toEqual({
      visible: true,
      idle: true,
      point: { x: 500, y: 400 }
    })
  })

  it('is idempotent: every phase of a run may ask for it', async () => {
    layer.showAgentPointer()
    await settle()
    layer.showAgentPointer()
    layer.showAgentPointer()
    await settle()

    expect(state.windows).toHaveLength(1)
    expect(win().shown).toBe(1)
  })

  it('stays on screen across a long gap between actions', async () => {
    // The mark describes the run, not the step: half a minute of model time is
    // not a reason to disappear.
    layer.showAgentPointer()
    await settle()
    await vi.advanceTimersByTimeAsync(60_000)

    expect(win().hidden).toBe(0)
    expect(win().sent.at(-1)?.visible).toBe(true)
  })

  it('turns the idle mark into a gesture when the first action lands', async () => {
    layer.showAgentPointer()
    await settle()
    layer.presentAgentAction(action())
    await settle()

    expect(win().sent.at(-1)).toMatchObject({
      visible: true,
      idle: false,
      point: { x: 120, y: 300 },
      gesture: 'click'
    })
    // It was already on screen, so it travels from where it is rather than
    // being re-introduced.
    expect(win().sent.at(-1)?.from).toBeUndefined()
    expect(win().shown).toBe(1)
  })
})

describe('updateAgentPointer: the mark follows the run', () => {
  it('is on screen from the first phase, before any action', async () => {
    layer.updateAgentPointer(phase('arming'))
    await settle()

    expect(win().shown).toBe(1)
    expect(win().sent.at(-1)).toMatchObject({ visible: true, idle: true })
  })

  it('stays up through a step and through a question', async () => {
    layer.updateAgentPointer(phase('arming'))
    await settle()
    layer.updateAgentPointer({ ...phase('acting'), step: 1, total: 4 })
    await settle()
    layer.updateAgentPointer(phase('asking'))
    await settle()

    expect(win().hidden).toBe(0)
    expect(win().shown).toBe(1)
  })

  it('leaves on every terminal phase', async () => {
    for (const terminal of ['done', 'aborted', 'error', 'idle'] as const) {
      layer.updateAgentPointer(phase('acting'))
      await settle()
      layer.updateAgentPointer(phase(terminal))
      await vi.advanceTimersByTimeAsync(240)

      expect(win().hidden, terminal).toBe(1)
      // The next phase starts a fresh run with a fresh window.
      vi.resetModules()
      layer = await load()
      state.windows = []
    }
  })

  it('does not flash when a step repeats the same phase', async () => {
    layer.updateAgentPointer(phase('acting'))
    await settle()
    layer.updateAgentPointer({ ...phase('acting'), step: 2 })
    layer.updateAgentPointer({ ...phase('acting'), step: 3 })
    await settle()

    expect(win().hidden).toBe(0)
    expect(win().shown).toBe(1)
  })
})

describe('presentAgentAction: getting out of the way', () => {
  it('does not hide on its own after the last action', async () => {
    layer.presentAgentAction(action())
    await settle()
    await vi.advanceTimersByTimeAsync(10_000)

    expect(win().hidden).toBe(0)
    expect(win().sent.at(-1)?.visible).toBe(true)
  })

  it('hides at the end of a run', async () => {
    layer.presentAgentAction(action())
    await settle()

    layer.hideAgentPresentation()
    await vi.advanceTimersByTimeAsync(240)

    expect(win().hidden).toBe(1)
  })

  it('ignores a hide that arrives before the window has loaded', async () => {
    // The run can end before the page finished parsing; the mark must not be
    // shown afterwards by the paint that was still waiting.
    layer.presentAgentAction(action())
    layer.hideAgentPresentation()
    await settle()

    expect(win().hidden).toBe(0)
    expect(win().sent.at(-1)?.visible ?? false).toBe(false)
  })

  it('destroys the window on quit', async () => {
    layer.presentAgentAction(action())
    await settle()

    layer.destroyAgentPresentation()
    expect(win().destroyed).toBe(true)
  })
})
