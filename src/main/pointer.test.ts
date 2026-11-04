import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { Annotation, ScreenRect } from '@shared/types'

/**
 * The drawing layer's arithmetic and its state machine: normalised coordinates →
 * screen points, the minimum ring around a single point, where the layer is
 * placed, and when it is shown or hidden.
 *
 * The window is a fake; nothing is drawn on a real screen. The module keeps its
 * state at module scope, so every test imports a fresh copy.
 */

const env = vi.hoisted(() => ({
  sent: [] as Array<{ channel: string; payload: unknown }>,
  bounds: [] as Array<{ x: number; y: number; width: number; height: number }>,
  shown: 0,
  hidden: 0,
  destroyed: 0,
  created: 0,
  dismiss: null as (() => void) | null,
  stopWatcher: vi.fn(),
  calls: [] as string[]
}))

vi.mock('./native/helper', () => ({
  watchForAbort: (_options: unknown, callback: () => void) => {
    env.dismiss = callback
    return { stop: env.stopWatcher }
  }
}))

vi.mock('electron', () => {
  class FakeWebContents {
    once(event: string, handler: () => void): void {
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
    shell: { openExternal: async () => undefined }
  }
})

async function loadPointer(): Promise<typeof import('./pointer')> {
  vi.resetModules()
  return import('./pointer')
}

const AREA: ScreenRect = { x: 100, y: 200, width: 800, height: 600 }

function shape(kind: Annotation['kind'], from: [number, number], to: [number, number]): Annotation {
  return { kind, from: { x: from[0], y: from[1] }, to: { x: to[0], y: to[1] } }
}

function lastPayload(): import('@shared/types').PointerPayload {
  return env.sent.at(-1)?.payload as import('@shared/types').PointerPayload
}

beforeEach(() => {
  env.dismiss = null
  env.stopWatcher.mockClear()
  env.sent = []
  env.bounds = []
  env.shown = 0
  env.hidden = 0
  env.destroyed = 0
  env.created = 0
  env.calls = []
  vi.useRealTimers()
})

describe('pointer: normalised coordinates become screen points', () => {
  it('maps 0..1 onto the layer size', async () => {
    const { showAnnotations } = await loadPointer()
    await showAnnotations(AREA, [shape('arrow', [0, 0], [1, 1])])

    expect(lastPayload().shapes[0]).toMatchObject({
      kind: 'arrow',
      from: { x: 0, y: 0 },
      to: { x: 800, y: 600 }
    })
  })

  it('keeps the kind and the label as they were parsed', async () => {
    const { showAnnotations } = await loadPointer()
    const labelled: Annotation = { ...shape('underline', [0.1, 0.2], [0.3, 0.2]), label: 'Сюда' }
    await showAnnotations(AREA, [labelled])

    expect(lastPayload().shapes[0]).toMatchObject({ kind: 'underline', label: 'Сюда' })
  })

  it('numbers the shapes so the renderer can stagger them', async () => {
    const { showAnnotations } = await loadPointer()
    await showAnnotations(AREA, [
      shape('arrow', [0.1, 0.1], [0.2, 0.2]),
      shape('circle', [0.3, 0.3], [0.5, 0.5])
    ])

    expect(lastPayload().shapes.map((entry) => entry.id)).toEqual(['0', '1'])
  })

  it('grows a single point into a visible ring instead of an invisible dot', async () => {
    const { showAnnotations } = await loadPointer()
    // A circle given as one point: centre (400, 300), 16 pt minimum radius, 6 pt pad.
    await showAnnotations(AREA, [shape('circle', [0.5, 0.5], [0.5, 0.5])])

    expect(lastPayload().shapes[0]).toMatchObject({
      from: { x: 400 - 16 - 6, y: 300 - 16 - 6 },
      to: { x: 400 + 16 + 6, y: 300 + 16 + 6 }
    })
  })

  it('never pushes a ring past the layer edges', async () => {
    const { showAnnotations } = await loadPointer()
    await showAnnotations(AREA, [shape('box', [0.001, 0.001], [0.001, 0.001])])

    const [only] = lastPayload().shapes
    expect(only.from.x).toBeGreaterThanOrEqual(0)
    expect(only.from.y).toBeGreaterThanOrEqual(0)
    expect(only.to.x).toBeLessThanOrEqual(800)
    expect(only.to.y).toBeLessThanOrEqual(600)
  })
})

describe('pointer: the layer', () => {
  it('sits exactly over the captured rectangle', async () => {
    const { showAnnotations } = await loadPointer()
    await showAnnotations(AREA, [shape('arrow', [0.1, 0.1], [0.2, 0.2])])

    expect(env.bounds.at(-1)).toEqual({ x: 100, y: 200, width: 800, height: 600 })
  })

  it('reports the layer size in the payload', async () => {
    const { showAnnotations } = await loadPointer()
    await showAnnotations(AREA, [shape('arrow', [0.1, 0.1], [0.2, 0.2])])

    expect(lastPayload()).toMatchObject({ width: 800, height: 600, visible: true })
  })

  it('does not move the layer when the rectangle has not changed', async () => {
    const { showAnnotations } = await loadPointer()
    await showAnnotations(AREA, [shape('arrow', [0.1, 0.1], [0.2, 0.2])])
    const applied = env.bounds.length

    await showAnnotations(AREA, [shape('arrow', [0.3, 0.3], [0.4, 0.4])])
    expect(env.bounds.length).toBe(applied)
  })

  it('moves the layer when the rectangle moves, rounding to whole points', async () => {
    const { showAnnotations } = await loadPointer()
    await showAnnotations(AREA, [shape('arrow', [0.1, 0.1], [0.2, 0.2])])
    await showAnnotations({ x: 100.4, y: 199.6, width: 800.2, height: 600 }, [
      shape('arrow', [0.1, 0.1], [0.2, 0.2])
    ])

    expect(env.bounds.at(-1)).toEqual({ x: 100, y: 200, width: 800, height: 600 })
  })

  it('bumps the revision so the renderer replays its animation', async () => {
    const { showAnnotations } = await loadPointer()
    await showAnnotations(AREA, [shape('arrow', [0.1, 0.1], [0.2, 0.2])])
    const first = lastPayload().revision
    await showAnnotations(AREA, [shape('arrow', [0.1, 0.1], [0.2, 0.2])])

    expect(lastPayload().revision).toBe(first + 1)
  })

  it('shows the window once, and not again for the next drawing', async () => {
    const { showAnnotations } = await loadPointer()
    await showAnnotations(AREA, [shape('arrow', [0.1, 0.1], [0.2, 0.2])])
    await showAnnotations(AREA, [shape('arrow', [0.3, 0.3], [0.4, 0.4])])

    expect(env.shown).toBe(1)
  })

  it('stays out of focus, out of clicks and out of screenshots', async () => {
    const { showAnnotations } = await loadPointer()
    await showAnnotations(AREA, [shape('arrow', [0.1, 0.1], [0.2, 0.2])])

    expect(env.calls).toContain('setIgnoreMouseEvents')
    expect(env.calls).toContain('setAlwaysOnTop')
    expect(env.calls).toContain('setVisibleOnAllWorkspaces')
    expect(env.calls).toContain('setContentProtection')
  })
})

describe('pointer: hiding', () => {
  it('clears drawings and notifies the session on user interaction', async () => {
    const { showAnnotations, isPointerVisible } = await loadPointer()
    const onDismiss = vi.fn()
    await showAnnotations(AREA, [shape('arrow', [0.1, 0.1], [0.2, 0.2])], onDismiss)

    env.dismiss?.()

    expect(isPointerVisible()).toBe(false)
    expect(lastPayload()).toMatchObject({ visible: false, shapes: [] })
    expect(onDismiss).toHaveBeenCalledOnce()
    expect(env.stopWatcher).toHaveBeenCalledOnce()
  })

  it('hides on an empty list without creating a window', async () => {
    const { showAnnotations, isPointerVisible } = await loadPointer()
    await showAnnotations(AREA, [])

    expect(env.created).toBe(0)
    expect(isPointerVisible()).toBe(false)
  })

  it('sends an invisible payload and hides after the fade', async () => {
    vi.useFakeTimers()
    const { showAnnotations, hideAnnotations, isPointerVisible } = await loadPointer()
    await showAnnotations(AREA, [shape('arrow', [0.1, 0.1], [0.2, 0.2])])

    hideAnnotations()
    expect(lastPayload()).toMatchObject({ visible: false, shapes: [] })
    expect(isPointerVisible()).toBe(false)
    expect(env.hidden).toBe(0)

    await vi.advanceTimersByTimeAsync(300)
    expect(env.hidden).toBe(1)
  })

  it('does not hide when a new drawing arrived during the fade', async () => {
    vi.useFakeTimers()
    const { showAnnotations, hideAnnotations } = await loadPointer()
    await showAnnotations(AREA, [shape('arrow', [0.1, 0.1], [0.2, 0.2])])

    hideAnnotations()
    await showAnnotations(AREA, [shape('arrow', [0.3, 0.3], [0.4, 0.4])])
    await vi.advanceTimersByTimeAsync(300)

    expect(env.hidden).toBe(0)
  })

  it('shows the window again after a hide', async () => {
    vi.useFakeTimers()
    const { showAnnotations, hideAnnotations } = await loadPointer()
    await showAnnotations(AREA, [shape('arrow', [0.1, 0.1], [0.2, 0.2])])
    hideAnnotations()
    await vi.advanceTimersByTimeAsync(300)

    await showAnnotations(AREA, [shape('arrow', [0.1, 0.1], [0.2, 0.2])])
    expect(env.shown).toBe(2)
  })
})

describe('pointer: destroy', () => {
  it('drops the window and the visibility flag', async () => {
    const { showAnnotations, destroyPointer, isPointerVisible } = await loadPointer()
    await showAnnotations(AREA, [shape('arrow', [0.1, 0.1], [0.2, 0.2])])

    destroyPointer()

    expect(env.destroyed).toBe(1)
    expect(isPointerVisible()).toBe(false)
  })

  it('creates a fresh window for the next drawing', async () => {
    const { showAnnotations, destroyPointer } = await loadPointer()
    await showAnnotations(AREA, [shape('arrow', [0.1, 0.1], [0.2, 0.2])])
    destroyPointer()

    await showAnnotations(AREA, [shape('arrow', [0.1, 0.1], [0.2, 0.2])])
    expect(env.created).toBe(2)
  })
})
