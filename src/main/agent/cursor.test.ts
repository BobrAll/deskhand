import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AgentCursorFrame, AgentEvent } from '@shared/types'
import type { FakeLayerWindow } from '../test/layerWindowMock'
import { lastLayerWindow } from '../test/layerWindowMock'

/**
 * `cursor.ts` keeps all of its state at module level, so every test imports a
 * fresh copy after resetting the fakes. No real window is created.
 */
const state = vi.hoisted(() => ({
  cursor: { x: 500, y: 400 },
  display: { x: 0, y: 0, width: 1440, height: 900 },
  windows: [] as FakeLayerWindow<AgentCursorFrame>[],
  shellOpened: [] as string[]
}))

vi.mock('electron', async () => {
  const { layerWindowClass } = await import('../test/layerWindowMock')
  return {
    BrowserWindow: layerWindowClass(state),
    screen: {
      getCursorScreenPoint: () => state.cursor,
      getDisplayNearestPoint: () => ({ bounds: state.display })
    },
    shell: {
      openExternal: async (url: string) => {
        state.shellOpened.push(url)
      }
    }
  }
})

type CursorModule = typeof import('./cursor')

let cursor: CursorModule

async function load(): Promise<CursorModule> {
  vi.resetModules()
  return import('./cursor')
}

function event(overrides: Partial<AgentEvent> & { phase: AgentEvent['phase'] }): AgentEvent {
  return {
    step: 0,
    total: 0,
    label: '',
    ...overrides
  }
}

/** Lets the pending promise chain of `paint()` settle. */
async function settle(): Promise<void> {
  for (let index = 0; index < 5; index += 1) await Promise.resolve()
  await vi.advanceTimersByTimeAsync(0)
  for (let index = 0; index < 5; index += 1) await Promise.resolve()
}

function win(): FakeLayerWindow<AgentCursorFrame> {
  return lastLayerWindow(state)
}

beforeEach(async () => {
  state.cursor = { x: 500, y: 400 }
  state.display = { x: 0, y: 0, width: 1440, height: 900 }
  state.windows = []
  state.shellOpened = []
  vi.useFakeTimers({
    toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval']
  })
  cursor = await load()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('updateAgentCursor: painting a step', () => {
  it('creates one window and shows it without taking focus', async () => {
    cursor.updateAgentCursor(event({ phase: 'arming', label: 'Приготовился' }))
    await settle()

    expect(state.windows).toHaveLength(1)
    expect(win().shown).toBe(1)
  })

  it('places the layer over the display', async () => {
    cursor.updateAgentCursor(event({ phase: 'arming', label: 'Приготовился' }))
    await settle()

    expect(win().bounds).toEqual({ x: 0, y: 0, width: 1440, height: 900 })
    expect(win().sent.at(-1)).toEqual({
      visible: true,
      phase: 'arming'
    })
  })

  it('repaints each step without asking for a new window', async () => {
    cursor.updateAgentCursor(event({ phase: 'arming' }))
    await settle()

    cursor.updateAgentCursor(event({ phase: 'acting', step: 1, total: 2 }))
    await settle()

    expect(win().sent.at(-1)).toMatchObject({
      visible: true,
      phase: 'acting'
    })
    expect(state.windows).toHaveLength(1)
  })

  it('reuses the same window for the next step', async () => {
    cursor.updateAgentCursor(event({ phase: 'arming', label: 'a' }))
    await settle()
    cursor.updateAgentCursor(event({ phase: 'acting', step: 1, total: 1, label: 'b' }))
    await settle()

    expect(state.windows).toHaveLength(1)
    expect(win().shown).toBe(1)
  })
})

describe('updateAgentCursor: following the pointer', () => {
  it('does not repaint while the pointer moves within one display', async () => {
    cursor.updateAgentCursor(event({ phase: 'arming', label: 'a' }))
    await settle()
    const bounds = win().bounds
    const painted = win().sent.length

    state.cursor = { x: 700, y: 600 }
    await vi.advanceTimersByTimeAsync(32)

    expect(win().sent).toHaveLength(painted)
    expect(win().bounds).toEqual(bounds)
  })

  it('moves the window once the pointer crosses to another display', async () => {
    cursor.updateAgentCursor(event({ phase: 'arming', label: 'a' }))
    await settle()

    state.display = { x: -1920, y: 0, width: 1920, height: 1080 }
    state.cursor = { x: -100, y: 100 }
    await vi.advanceTimersByTimeAsync(32)

    expect(win().bounds).toEqual({ x: -1920, y: 0, width: 1920, height: 1080 })
  })
})

describe('updateAgentCursor: asking and done', () => {
  it('parks the glow while the run waits for an answer', async () => {
    cursor.updateAgentCursor(event({ phase: 'acting', step: 1, total: 1, label: 'Клик' }))
    await settle()

    cursor.updateAgentCursor(event({ phase: 'asking', label: 'Нажать «Экспорт»' }))

    expect(win().sent.at(-1)).toMatchObject({ phase: 'waiting', visible: true })
  })

  it('ignores a question when no glow is on screen', async () => {
    cursor.updateAgentCursor(event({ phase: 'asking' }))

    expect(state.windows).toHaveLength(0)
  })

  it('hides the glow on `done` outside a turn', async () => {
    cursor.updateAgentCursor(event({ phase: 'acting', step: 1, total: 1, label: 'Клик' }))
    await settle()

    cursor.updateAgentCursor(event({ phase: 'done', label: 'Готово' }))
    await settle()

    expect(win().sent.at(-1)?.visible).toBe(false)
  })
})

describe('updateAgentCursor: a turn that spans several calls', () => {
  it('keeps the frame visible while the run goes back to look again', async () => {
    const token = cursor.beginAgentTurn(false)
    cursor.updateAgentCursor(event({ phase: 'arming' }))
    await settle()
    // The first plan of the turn finishes; the turn itself has not.
    cursor.updateAgentCursor(event({ phase: 'done', label: 'Готово' }))
    cursor.updateAgentCursor(event({ phase: 'asking', label: 'Подтверждение' }))
    await vi.advanceTimersByTimeAsync(8_000)

    expect(win().hidden).toBe(0)
    expect(win().sent.every((frame) => frame.visible)).toBe(true)
    expect(win().sent.at(-1)).toMatchObject({ phase: 'waiting' })
    cursor.endAgentTurn(token)
    await vi.advanceTimersByTimeAsync(200)
    expect(win().hidden).toBe(1)
  })

  it('shows the frame when a turn starts by asking a question', async () => {
    cursor.beginAgentTurn(false)
    cursor.updateAgentCursor(event({ phase: 'asking', label: 'Нажать «ОК»' }))
    await settle()
    expect(win().sent.at(-1)).toMatchObject({ visible: true, phase: 'waiting' })
  })

  it('parks the glow on a `done` inside a turn instead of hiding it', async () => {
    const token = cursor.beginAgentTurn(false)
    cursor.updateAgentCursor(event({ phase: 'acting', step: 1, total: 1, label: 'Клик' }))
    await settle()

    cursor.updateAgentCursor(event({ phase: 'done', label: 'Готово' }))

    // Still visible: the turn is not over.
    expect(win().sent.at(-1)?.visible).toBe(true)
    expect(token).toBeGreaterThan(0)
  })

  it('relaxes a parked glow into waiting after the pause', async () => {
    cursor.beginAgentTurn(false)
    cursor.updateAgentCursor(event({ phase: 'acting', step: 1, total: 1, label: 'Клик' }))
    await settle()

    cursor.updateAgentCursor(event({ phase: 'done', label: 'Готово' }))
    await vi.advanceTimersByTimeAsync(800)

    expect(win().sent.at(-1)).toMatchObject({ phase: 'waiting', visible: true })
  })

  it('does not park a glow that was never shown', async () => {
    cursor.beginAgentTurn(false)

    cursor.updateAgentCursor(event({ phase: 'done', label: 'Готово' }))
    await settle()

    expect(state.windows).toHaveLength(0)
  })

  it('a new turn takes the glow from the previous one', async () => {
    const first = cursor.beginAgentTurn(false)
    cursor.updateAgentCursor(event({ phase: 'acting', step: 1, total: 1, label: 'Клик' }))
    await settle()

    const second = cursor.beginAgentTurn(false)
    await settle()

    expect(second).toBeGreaterThan(first)
    expect(win().sent.at(-1)?.visible).toBe(false)
  })

  it('endAgentTurn is the moment the glow goes out', async () => {
    const token = cursor.beginAgentTurn(false)
    cursor.updateAgentCursor(event({ phase: 'acting', step: 1, total: 1, label: 'Клик' }))
    await settle()

    cursor.endAgentTurn(token)
    await settle()

    expect(win().sent.at(-1)?.visible).toBe(false)
  })

  it('ignores a release that belongs to an older turn', async () => {
    const first = cursor.beginAgentTurn(false)
    cursor.updateAgentCursor(event({ phase: 'acting', step: 1, total: 1, label: 'Клик' }))
    await settle()
    cursor.beginAgentTurn(false)
    cursor.updateAgentCursor(event({ phase: 'acting', step: 1, total: 1, label: 'Клик' }))
    await settle()

    cursor.endAgentTurn(first)
    await settle()

    // The newer turn still owns the glow.
    expect(win().sent.at(-1)?.visible).toBe(true)
  })

  it('a parked timer from an older turn does not repaint a newer one', async () => {
    cursor.beginAgentTurn(false)
    cursor.updateAgentCursor(event({ phase: 'acting', step: 1, total: 1, label: 'Клик' }))
    await settle()
    cursor.updateAgentCursor(event({ phase: 'done', label: 'Готово' }))

    cursor.beginAgentTurn(false)
    cursor.updateAgentCursor(event({ phase: 'acting', step: 1, total: 1, label: 'Новый шаг' }))
    await settle()
    await vi.advanceTimersByTimeAsync(800)

    // The newer turn is still acting: the previous turn's park timer did not
    // turn its step into "waiting".
    expect(win().sent.at(-1)?.phase).toBe('acting')
  })
})

describe('updateAgentCursor: hiding', () => {
  it('fades out, then hides the window after the animation', async () => {
    cursor.updateAgentCursor(event({ phase: 'acting', step: 1, total: 1, label: 'Клик' }))
    await settle()

    cursor.updateAgentCursor(event({ phase: 'aborted' }))
    await settle()
    expect(win().hidden).toBe(0)

    await vi.advanceTimersByTimeAsync(200)
    expect(win().hidden).toBe(1)
  })

  it('stops following once hidden', async () => {
    cursor.updateAgentCursor(event({ phase: 'acting', step: 1, total: 1, label: 'Клик' }))
    await settle()
    cursor.updateAgentCursor(event({ phase: 'idle' }))
    await vi.advanceTimersByTimeAsync(200)
    const painted = win().sent.length

    state.cursor = { x: 900, y: 800 }
    await vi.advanceTimersByTimeAsync(100)

    expect(win().sent).toHaveLength(painted)
  })

  it('a second hide does not cancel the fade-out in flight', async () => {
    cursor.updateAgentCursor(event({ phase: 'acting', step: 1, total: 1, label: 'Клик' }))
    await settle()
    cursor.updateAgentCursor(event({ phase: 'aborted' }))
    cursor.updateAgentCursor(event({ phase: 'aborted' }))
    await vi.advanceTimersByTimeAsync(200)

    expect(win().hidden).toBe(1)
  })

  it('hides safely when no window was ever created', async () => {
    cursor.updateAgentCursor(event({ phase: 'idle' }))

    expect(state.windows).toHaveLength(0)
  })

  it('paints again after a hide', async () => {
    cursor.updateAgentCursor(event({ phase: 'acting', step: 1, total: 1, label: 'a' }))
    await settle()
    cursor.updateAgentCursor(event({ phase: 'idle' }))
    await vi.advanceTimersByTimeAsync(200)

    cursor.updateAgentCursor(event({ phase: 'acting', step: 1, total: 1, label: 'b' }))
    await settle()

    expect(win().sent.at(-1)).toMatchObject({ visible: true, phase: 'acting' })
    expect(win().shown).toBe(2)
  })
})

describe('cursor completion', () => {
  it('keeps the success glow visible after turn cleanup, then hides it', async () => {
    const token = cursor.beginAgentTurn(false)
    cursor.updateAgentCursor(event({ phase: 'done', completed: true }))
    // Cleanup can run before the cursor window has finished loading.
    cursor.endAgentTurn(token)
    await settle()
    expect(win().sent.at(-1)).toMatchObject({ visible: true, phase: 'success' })
    await vi.advanceTimersByTimeAsync(1000)
    expect(win().hidden).toBe(0)
    await vi.advanceTimersByTimeAsync(300)
    expect(win().hidden).toBe(1)
  })

  it('does not let an old completion timer hide the next task', async () => {
    const token = cursor.beginAgentTurn(false)
    cursor.updateAgentCursor(event({ phase: 'done', completed: true }))
    await settle()
    cursor.endAgentTurn(token)
    cursor.beginAgentTurn(false)
    cursor.updateAgentCursor(event({ phase: 'acting', label: 'Следующая задача' }))
    await settle()
    await vi.advanceTimersByTimeAsync(1400)
    expect(win().sent.at(-1)).toMatchObject({ visible: true, phase: 'acting' })
    expect(win().hidden).toBe(0)
  })
})

describe('destroyAgentCursor', () => {
  it('destroys the window and stops every timer', async () => {
    cursor.beginAgentTurn(false)
    cursor.updateAgentCursor(event({ phase: 'acting', step: 1, total: 1, label: 'Клик' }))
    await settle()

    cursor.destroyAgentCursor()

    expect(win().destroyed).toBe(true)
    const painted = win().sent.length
    state.cursor = { x: 1, y: 1 }
    await vi.advanceTimersByTimeAsync(200)
    expect(win().sent).toHaveLength(painted)
  })

  it('is safe to call twice', async () => {
    cursor.updateAgentCursor(event({ phase: 'acting', step: 1, total: 1, label: 'a' }))
    await settle()

    cursor.destroyAgentCursor()

    expect(() => cursor.destroyAgentCursor()).not.toThrow()
  })
})

describe('early request feedback', () => {
  it('shows a waiting glow before any plan exists and removes it on cancellation', async () => {
    const token = cursor.beginAgentTurn(true)
    await settle()
    expect(win().sent.at(-1)).toMatchObject({ visible: true, phase: 'waiting' })
    cursor.endAgentTurn(token)
    await settle()
    expect(win().sent.at(-1)?.visible).toBe(false)
  })
  it('does not resurrect a request cancelled while the layer was loading', async () => {
    const token = cursor.beginAgentTurn(true)
    cursor.endAgentTurn(token)
    await settle()
    expect(win().shown).toBe(0)
  })
})
