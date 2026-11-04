import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The bubble's decisions: which side of the pointer the chip goes on, where the
 * layer is placed, what a frame says, and when the window is shown or hidden.
 *
 * The window itself is a fake — nothing is created on screen. What is checked is
 * the arithmetic and the ordering, which is where this module can be wrong in a
 * way nobody notices until a chip hangs off the edge of a display.
 */

const env = vi.hoisted(() => ({
  cursor: { x: 500, y: 400 },
  workArea: { x: 0, y: 0, width: 1440, height: 900 },
  /** Frames sent to the renderer, in order. */
  sent: [] as Array<{ channel: string; payload: unknown }>,
  bounds: [] as Array<{ x: number; y: number; width: number; height: number }>,
  shown: 0,
  hidden: 0,
  destroyed: 0,
  created: 0,
  /** Methods called on the window that the test cares about. */
  calls: [] as string[]
}))

vi.mock('electron', () => {
  class FakeWebContents {
    once(event: string, handler: () => void): void {
      // The page is "already loaded": fire immediately so `ensureWindow` settles.
      if (event === 'did-finish-load') handler()
    }
    send(channel: string, payload: unknown): void {
      env.sent.push({ channel, payload })
    }
    setWindowOpenHandler(): void {
      env.calls.push('setWindowOpenHandler')
    }
  }

  class FakeBrowserWindow {
    readonly webContents = new FakeWebContents()
    constructor() {
      env.created += 1
    }
    isDestroyed(): boolean {
      return false
    }
    setIgnoreMouseEvents(): void {
      env.calls.push('setIgnoreMouseEvents')
    }
    setAlwaysOnTop(): void {
      env.calls.push('setAlwaysOnTop')
    }
    setVisibleOnAllWorkspaces(): void {
      env.calls.push('setVisibleOnAllWorkspaces')
    }
    setContentProtection(): void {
      env.calls.push('setContentProtection')
    }
    setBounds(next: { x: number; y: number; width: number; height: number }): void {
      env.bounds.push(next)
    }
    showInactive(): void {
      env.shown += 1
    }
    hide(): void {
      env.hidden += 1
    }
    destroy(): void {
      env.destroyed += 1
    }
    on(): void {
      /* 'closed' is never fired by the fake */
    }
    loadFile(): void {
      env.calls.push('loadFile')
    }
  }

  return {
    BrowserWindow: FakeBrowserWindow,
    screen: {
      getCursorScreenPoint: () => env.cursor,
      getDisplayNearestPoint: () => ({ workArea: env.workArea })
    },
    shell: { openExternal: async () => undefined }
  }
})

async function loadHud(): Promise<typeof import('./hud')> {
  vi.resetModules()
  return import('./hud')
}

/** Lets the async paint path run to its `send`. */
async function flush(): Promise<void> {
  for (let index = 0; index < 12; index += 1) await Promise.resolve()
}

function lastFrame(): import('@shared/types').HudFrame | null {
  const frame = env.sent.at(-1)
  return frame ? (frame.payload as import('@shared/types').HudFrame) : null
}

beforeEach(() => {
  env.cursor = { x: 500, y: 400 }
  env.workArea = { x: 0, y: 0, width: 1440, height: 900 }
  env.sent = []
  env.bounds = []
  env.shown = 0
  env.hidden = 0
  env.destroyed = 0
  env.created = 0
  env.calls = []
  vi.useRealTimers()
})

describe('hud: what a frame says', () => {
  it('reports the phase, the level and a visible frame while listening', async () => {
    const { createCursorHud } = await loadHud()
    const hud = createCursorHud({ avoid: () => null })

    hud.update({ phase: 'listening', level: 0.42 })
    await flush()

    expect(lastFrame()).toMatchObject({ visible: true, phase: 'listening', level: 0.42 })
  })

  it('clamps the level into 0..1 and treats junk as silence', async () => {
    const { createCursorHud } = await loadHud()
    const hud = createCursorHud({ avoid: () => null })

    hud.update({ phase: 'listening', level: 3 })
    await flush()
    expect(lastFrame()?.level).toBe(1)

    hud.update({ phase: 'listening', level: Number.NaN })
    await flush()
    expect(lastFrame()?.level).toBe(0)
  })

  it('drops the level to zero while transcribing', async () => {
    const { createCursorHud } = await loadHud()
    const hud = createCursorHud({ avoid: () => null })

    hud.update({ phase: 'listening', level: 0.9 })
    await flush()
    hud.update({ phase: 'transcribing', level: 0.9 })
    await flush()

    expect(lastFrame()).toMatchObject({ phase: 'transcribing', level: 0 })
  })

  it('answers getState with the last painted frame, and null before any', async () => {
    const { createCursorHud } = await loadHud()
    const hud = createCursorHud({ avoid: () => null })

    expect(hud.getState()).toBeNull()
    hud.update({ phase: 'listening', level: 0.5 })
    await flush()
    expect(hud.getState()).toEqual(lastFrame())
  })
})

describe('hud: which side of the pointer the chip goes on', () => {
  it('prefers below when there is room and nothing to avoid', async () => {
    const { createCursorHud } = await loadHud()
    const hud = createCursorHud({ avoid: () => null })

    hud.update({ phase: 'listening', level: 0.5 })
    await flush()

    expect(lastFrame()?.side).toBe('below')
  })

  it('steps aside when the card sits right under the pointer', async () => {
    const { createCursorHud } = await loadHud()
    // The card opens down-and-right of the pointer, so `below` lands on it and
    // `right` is still within its 10 pt pad — the chip goes above instead.
    const hud = createCursorHud({
      avoid: () => ({ x: 400, y: 420, width: 420, height: 300 })
    })

    hud.update({ phase: 'listening', level: 0.5 })
    await flush()

    expect(lastFrame()?.side).toBe('above')
  })

  it('picks the right-hand side when the card is clear of it', async () => {
    const { createCursorHud } = await loadHud()
    // Same card, but far enough below that only `below` collides.
    const hud = createCursorHud({
      avoid: () => ({ x: 400, y: 440, width: 420, height: 300 })
    })

    hud.update({ phase: 'listening', level: 0.5 })
    await flush()

    expect(lastFrame()?.side).toBe('right')
  })

  it('falls back to a side that merely fits when every side is occupied', async () => {
    const { createCursorHud } = await loadHud()
    // A card covering the whole work area: nothing is clear, but `below` fits.
    const hud = createCursorHud({
      avoid: () => ({ x: 0, y: 0, width: 1440, height: 900 })
    })

    hud.update({ phase: 'listening', level: 0.5 })
    await flush()

    expect(lastFrame()?.side).toBe('below')
  })

  it('keeps the chip on screen at the very bottom edge', async () => {
    env.cursor = { x: 700, y: 899 }
    const { createCursorHud } = await loadHud()
    const hud = createCursorHud({ avoid: () => null })

    hud.update({ phase: 'listening', level: 0.5 })
    await flush()

    // `below` would hang off the display, so the chip moves above the pointer.
    expect(lastFrame()?.side).toBe('above')
  })

  it('survives an `avoid` that throws because the card closed underneath it', async () => {
    const { createCursorHud } = await loadHud()
    const hud = createCursorHud({
      avoid: () => {
        throw new Error('window destroyed')
      }
    })

    hud.update({ phase: 'listening', level: 0.5 })
    await flush()

    expect(lastFrame()?.visible).toBe(true)
    expect(lastFrame()?.side).toBe('below')
  })
})

describe('hud: where the layer goes', () => {
  it('centres the layer on the pointer', async () => {
    const { createCursorHud } = await loadHud()
    const hud = createCursorHud({ avoid: () => null })

    hud.update({ phase: 'listening', level: 0.5 })
    await flush()

    // 320×160 layer, pointer at (500, 400) → layer at (340, 320), anchor (160, 80).
    expect(env.bounds.at(-1)).toEqual({ x: 340, y: 320, width: 320, height: 160 })
    expect(lastFrame()?.anchor).toEqual({ x: 160, y: 80 })
  })

  it('clamps the layer to the work area at a screen corner', async () => {
    env.cursor = { x: 5, y: 5 }
    const { createCursorHud } = await loadHud()
    const hud = createCursorHud({ avoid: () => null })

    hud.update({ phase: 'listening', level: 0.5 })
    await flush()

    // The layer is pinned to the display; the anchor carries the real pointer.
    expect(env.bounds.at(-1)).toMatchObject({ x: 0, y: 0 })
    expect(lastFrame()?.anchor).toEqual({ x: 5, y: 5 })
  })

  it('does not re-apply bounds when the pointer has not moved', async () => {
    const { createCursorHud } = await loadHud()
    const hud = createCursorHud({ avoid: () => null })

    hud.update({ phase: 'listening', level: 0.2 })
    await flush()
    const applied = env.bounds.length

    hud.update({ phase: 'listening', level: 0.6 })
    await flush()

    expect(env.bounds.length).toBe(applied)
  })

  it('shows the window once, before the first frame is sent', async () => {
    const { createCursorHud } = await loadHud()
    const hud = createCursorHud({ avoid: () => null })

    hud.update({ phase: 'listening', level: 0.2 })
    await flush()
    hud.update({ phase: 'listening', level: 0.4 })
    await flush()

    expect(env.shown).toBe(1)
    expect(env.sent.filter((entry) => (entry.payload as { visible: boolean }).visible)).toHaveLength(2)
  })
})

describe('hud: hiding', () => {
  it('sends an invisible frame and hides the window after the fade', async () => {
    vi.useFakeTimers()
    const { createCursorHud } = await loadHud()
    const hud = createCursorHud({ avoid: () => null })

    hud.update({ phase: 'listening', level: 0.5 })
    await vi.advanceTimersByTimeAsync(0)

    hud.update({ phase: 'idle', level: 0 })
    await vi.advanceTimersByTimeAsync(0)

    expect(lastFrame()).toMatchObject({ visible: false, level: 0 })
    expect(env.hidden).toBe(0)

    await vi.advanceTimersByTimeAsync(200)
    expect(env.hidden).toBe(1)
  })

  it('does not resurrect a finished turn with a late paint', async () => {
    vi.useFakeTimers()
    const { createCursorHud } = await loadHud()
    const hud = createCursorHud({ avoid: () => null })

    hud.update({ phase: 'listening', level: 0.5 })
    await vi.advanceTimersByTimeAsync(0)
    const before = env.sent.length

    hud.update({ phase: 'idle', level: 0 })
    await vi.advanceTimersByTimeAsync(200)

    // Only the fade-out frame: nothing arrives after it.
    expect(env.sent.length).toBe(before + 1)
    expect(env.hidden).toBe(1)
  })

  it('hides nothing when there was never a turn', async () => {
    vi.useFakeTimers()
    const { createCursorHud } = await loadHud()
    const hud = createCursorHud({ avoid: () => null })

    hud.update({ phase: 'idle', level: 0 })
    await vi.advanceTimersByTimeAsync(200)

    expect(env.sent).toEqual([])
    expect(env.hidden).toBe(0)
  })
})

describe('hud: the window itself', () => {
  it('creates the window on prewarm, without showing it', async () => {
    const { createCursorHud } = await loadHud()
    const hud = createCursorHud({ avoid: () => null })

    hud.prewarm()
    await flush()

    expect(env.created).toBe(1)
    expect(env.shown).toBe(0)
  })

  it('keeps the window out of focus, out of clicks and out of screenshots', async () => {
    const { createCursorHud } = await loadHud()
    const hud = createCursorHud({ avoid: () => null })

    hud.prewarm()
    await flush()

    expect(env.calls).toContain('setIgnoreMouseEvents')
    expect(env.calls).toContain('setAlwaysOnTop')
    expect(env.calls).toContain('setVisibleOnAllWorkspaces')
    // Without this the bubble would be photographed into the model's screenshot.
    expect(env.calls).toContain('setContentProtection')
  })

  it('destroys the window and forgets the frame', async () => {
    const { createCursorHud } = await loadHud()
    const hud = createCursorHud({ avoid: () => null })

    hud.update({ phase: 'listening', level: 0.5 })
    await flush()
    hud.destroy()

    expect(env.destroyed).toBe(1)
    expect(hud.getState()).toBeNull()
  })
})
