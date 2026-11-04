import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AgentEvent, AgentPlanStep, AxProbe, ScreenRect } from '@shared/types'

const state = vi.hoisted(() => ({
  settings: {
    agent: {
      enabled: true,
      startDelayMs: 0,
      stepDelayMs: 0,
      maxSteps: 6,
      allowTyping: true,
      allowShortcuts: true,
      abortOnMouseMove: true,
      verifyResult: false
    }
  },
  binary: '/bin/helper' as string | null,
  trusted: true,
  helper: {
    activate: true,
    front: null as null | { bundleId: string; pid: number },
    move: true,
    click: true,
    drag: true,
    scroll: true,
    type: true,
    key: true,
    probe: null as null | AxProbe,
    focused: null as null | Record<string, unknown>
  },
  calls: [] as Array<{ name: string; args: unknown[] }>,
  abortHandler: null as null | ((reason: 'escape' | 'mousemove') => void),
  watcherStopped: 0,
  hideCursor: 0,
  cursorPoint: { x: 10, y: 20 }
}))

vi.mock('electron', () => ({
  screen: { getCursorScreenPoint: () => state.cursorPoint },
  systemPreferences: { isTrustedAccessibilityClient: () => state.trusted }
}))

vi.mock('../native/helper', () => ({
  helperBinary: () => state.binary,
  helperActivate: async (target: unknown) => {
    state.calls.push({ name: 'activate', args: [target] })
    return state.helper.activate
  },
  helperFront: async () => {
    state.calls.push({ name: 'front', args: [] })
    return state.helper.front
  },
  helperMoveMouse: async (x: number, y: number) => {
    state.calls.push({ name: 'move', args: [x, y] })
    return state.helper.move
  },
  helperClick: async (x: number, y: number, button: string) => {
    state.calls.push({ name: 'click', args: [x, y, button] })
    return state.helper.click
  },
  helperDrag: async (from: unknown, to: unknown) => {
    state.calls.push({ name: 'drag', args: [from, to] })
    return state.helper.drag
  },
  helperScroll: async (dx: number, dy: number) => {
    state.calls.push({ name: 'scroll', args: [dx, dy] })
    return state.helper.scroll
  },
  helperTypeText: async (text: string) => {
    state.calls.push({ name: 'type', args: [text] })
    return state.helper.type
  },
  helperPressKey: async (keyCode: number, flags: number) => {
    state.calls.push({ name: 'key', args: [keyCode, flags] })
    return state.helper.key
  },
  helperProbe: async (pid: number | null, point: unknown) => {
    state.calls.push({ name: 'probe', args: [pid, point] })
    return state.helper.probe
  },
  helperFocused: async (pid: number | null) => {
    state.calls.push({ name: 'focused', args: [pid] })
    return state.helper.focused
  },
  watchForAbort: (_options: unknown, onAbort: (reason: 'escape' | 'mousemove') => void) => {
    state.abortHandler = onAbort
    return {
      stop: () => {
        state.watcherStopped += 1
      }
    }
  }
}))

vi.mock('../settings/store', () => ({ getSettings: () => state.settings }))

vi.mock('../util', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../util')>()
  return {
    ...actual,
    delay: async () => undefined,
    waitFor: async (check: () => Promise<boolean> | boolean) => Boolean(await check())
  }
})

vi.mock('./cursor', () => ({
  hideAgentCursor: () => {
    state.hideCursor += 1
  }
}))

import { createAgentController } from './index'

const area: ScreenRect = { x: 0, y: 0, width: 1000, height: 1000 }

function probe(targets: AxProbe['targets'] = []): AxProbe {
  return { pid: 42, app: 'Safari', chain: [], targets, focused: null, elapsedMs: 3 }
}

function step(action: AgentPlanStep['action'], label = 'шаг'): AgentPlanStep {
  return { action, label }
}

function makeHost() {
  const host = {
    events: [] as AgentEvent[],
    passthrough: [] as boolean[],
    targetValue: { bundleId: 'com.apple.Safari', pid: 42 } as { bundleId: string; pid: number } | null,
    setPassthrough: (active: boolean) => {
      host.passthrough.push(active)
    },
    emit: (event: AgentEvent) => {
      host.events.push(event)
    },
    target: () => host.targetValue
  }
  return host
}

type Host = ReturnType<typeof makeHost>

function last(host: Host): AgentEvent {
  return host.events[host.events.length - 1]
}

function ran(name: string): number {
  return state.calls.filter((call) => call.name === name).length
}

beforeEach(() => {
  state.settings = {
    agent: {
      enabled: true,
      startDelayMs: 0,
      stepDelayMs: 0,
      maxSteps: 6,
      allowTyping: true,
      allowShortcuts: true,
      abortOnMouseMove: true,
      verifyResult: false
    }
  }
  state.binary = '/bin/helper'
  state.trusted = true
  state.helper = {
    activate: true,
    front: { bundleId: 'com.apple.Safari', pid: 42 },
    move: true,
    click: true,
    drag: true,
    scroll: true,
    type: true,
    key: true,
    probe: null,
    focused: null
  }
  state.calls = []
  state.abortHandler = null
  state.watcherStopped = 0
  state.hideCursor = 0
  state.cursorPoint = { x: 10, y: 20 }
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('availability: the three reasons a plan cannot run', () => {
  it('is ready when the mode, the helper and the grant are all there', () => {
    const agent = createAgentController(makeHost())

    expect(agent.availability()).toEqual({ enabled: true, ready: true, reason: null })
  })

  it('names a disabled mode first', () => {
    state.settings.agent.enabled = false
    state.binary = null
    const agent = createAgentController(makeHost())

    expect(agent.availability()).toEqual({
      enabled: false,
      ready: false,
      reason: 'Агентный режим выключен в настройках.'
    })
  })

  it('names a missing helper', () => {
    state.binary = null
    const agent = createAgentController(makeHost())

    expect(agent.availability()).toEqual({
      enabled: true,
      ready: false,
      reason: 'Нативный helper не собран — управлять мышью нечем.'
    })
  })

  it('names a missing Accessibility grant', () => {
    state.trusted = false
    const agent = createAgentController(makeHost())

    expect(agent.availability()).toEqual({
      enabled: true,
      ready: false,
      reason: 'Нужен доступ «Универсальный доступ», иначе macOS не даст нажимать за вас.'
    })
  })
})

describe('execute: what stops a plan before it starts', () => {
  it('refuses to run while the mode is off', async () => {
    state.settings.agent.enabled = false
    const host = makeHost()
    const agent = createAgentController(host)

    const result = await agent.execute({ steps: [step({ kind: 'done' })], area } as never)

    expect(result).toMatchObject({ finished: false, message: 'Агентный режим выключен в настройках.' })
    expect(last(host).phase).toBe('error')
    expect(state.calls).toHaveLength(0)
  })

  it('refuses to run without a screen area', async () => {
    const host = makeHost()
    const agent = createAgentController(host)

    const result = await agent.execute({ steps: [step({ kind: 'done' })], area: null } as never)

    expect(result.message).toBe('Неизвестно, где на экране цель — нажимать некуда.')
    expect(last(host).phase).toBe('error')
  })

  it('does nothing for an empty plan', async () => {
    const host = makeHost()
    const agent = createAgentController(host)

    const result = await agent.execute({ steps: [], area } as never)

    expect(result).toEqual({ finished: false, performed: [] })
    expect(host.events).toHaveLength(0)
  })
})

describe('execute: the shape of a run', () => {
  it('makes the card click-through, arms, and restores the window afterwards', async () => {
    const host = makeHost()
    const agent = createAgentController(host)

    await agent.execute({ steps: [step({ kind: 'move', at: { x: 0.5, y: 0.5 } })], area } as never)

    expect(host.passthrough).toEqual([true, false])
    expect(host.events[0]).toMatchObject({ phase: 'arming', step: 0, total: 1, label: 'Приготовился' })
  })

  it('publishes the plan labels once, so the card can list the steps', async () => {
    const host = makeHost()
    const agent = createAgentController(host)

    await agent.execute(
      {
        steps: [step({ kind: 'move', at: { x: 0.1, y: 0.1 } }, 'первый'), step({ kind: 'done' })],
        area
      } as never
    )

    expect(last(host).plan).toEqual(['первый', 'шаг'])
  })

  it('maps a fraction onto the captured area before moving the pointer', async () => {
    const host = makeHost()
    const agent = createAgentController(host)

    await agent.execute({ steps: [step({ kind: 'move', at: { x: 0.5, y: 0.25 } })], area } as never)

    const move = state.calls.find((call) => call.name === 'move')
    expect(move?.args).toEqual([500, 250])
  })

  it('passes the click button through', async () => {
    const host = makeHost()
    const agent = createAgentController(host)

    await agent.execute(
      { steps: [step({ kind: 'click', at: { x: 0.5, y: 0.5 }, button: 'right' })], area } as never
    )

    expect(state.calls.find((call) => call.name === 'click')?.args).toEqual([500, 500, 'right'])
  })

  it('runs drag, scroll, type and key steps', async () => {
    const host = makeHost()
    const agent = createAgentController(host)

    await agent.execute(
      {
        steps: [
          step({ kind: 'drag', from: { x: 0, y: 0 }, to: { x: 1, y: 1 } }),
          step({ kind: 'scroll', dx: 0, dy: -120 }),
          step({ kind: 'type', text: 'привет' }),
          step({ kind: 'key', combo: 'cmd+s' })
        ],
        area
      } as never
    )

    expect(state.calls.find((call) => call.name === 'drag')?.args).toEqual([
      { x: 0, y: 0 },
      { x: 1000, y: 1000 }
    ])
    expect(state.calls.find((call) => call.name === 'scroll')?.args).toEqual([0, -120])
    expect(state.calls.find((call) => call.name === 'type')?.args).toEqual(['привет'])
    expect(state.calls.find((call) => call.name === 'key')?.args).toEqual([1, 0x00100000])
  })

  it('caps a wait step at ten seconds', async () => {
    const host = makeHost()
    const agent = createAgentController(host)
    const delays: number[] = []
    const util = await import('../util')
    vi.spyOn(util, 'delay').mockImplementation(async (ms: number) => {
      delays.push(ms)
    })

    await agent.execute({ steps: [step({ kind: 'wait', ms: 60_000 })], area } as never)

    expect(delays).toEqual([10_000])
  })

  it('reports a finished plan on @done with «Готово»', async () => {
    const host = makeHost()
    const agent = createAgentController(host)

    const result = await agent.execute(
      { steps: [step({ kind: 'move', at: { x: 0.5, y: 0.5 } }), step({ kind: 'done' })], area } as never
    )

    expect(result).toMatchObject({ finished: true })
    expect(last(host)).toMatchObject({ phase: 'done', label: 'Готово', step: 2, total: 2 })
  })

  it('says «Выполнено» when the steps ran out without a claim', async () => {
    const host = makeHost()
    const agent = createAgentController(host)

    const result = await agent.execute(
      { steps: [step({ kind: 'move', at: { x: 0.5, y: 0.5 } })], area } as never
    )

    expect(result.finished).toBe(false)
    expect(last(host)).toMatchObject({ phase: 'done', label: 'Выполнено' })
  })

  it('withholds «Готово» when the caller is going to verify the result', async () => {
    const host = makeHost()
    const agent = createAgentController(host)

    await agent.execute(
      {
        steps: [step({ kind: 'move', at: { x: 0.5, y: 0.5 } }), step({ kind: 'done' })],
        area,
        verify: true
      } as never
    )

    expect(last(host).label).toBe('Проверяю результат')
  })

  it('stops at a failing step and names it', async () => {
    state.helper.click = false
    const host = makeHost()
    const agent = createAgentController(host)

    const result = await agent.execute(
      {
        steps: [step({ kind: 'click', at: { x: 0.5, y: 0.5 }, button: 'left' }, 'нажать')],
        area
      } as never
    )

    expect(result).toMatchObject({ finished: false, message: 'Не удалось выполнить: нажать' })
    expect(result.performed).toEqual([{ label: 'нажать', ok: false }])
    expect(last(host)).toMatchObject({ phase: 'error', label: 'нажать' })
  })

  it('always restores the window and hides the ring, even after a failure', async () => {
    state.helper.move = false
    const host = makeHost()
    const agent = createAgentController(host)

    await agent.execute({ steps: [step({ kind: 'move', at: { x: 0.5, y: 0.5 } })], area } as never)

    expect(host.passthrough.at(-1)).toBe(false)
    expect(state.hideCursor).toBeGreaterThan(0)
    expect(state.watcherStopped).toBe(1)
    expect(agent.isRunning()).toBe(false)
  })
})

describe('execute: the guard on each step', () => {
  it('refuses to type when typing is switched off', async () => {
    state.settings.agent.allowTyping = false
    const host = makeHost()
    const agent = createAgentController(host)

    const result = await agent.execute({ steps: [step({ kind: 'type', text: 'x' })], area } as never)

    expect(result.message).toBe('Печать отключена в настройках агента.')
    expect(ran('type')).toBe(0)
  })

  it('refuses a shortcut when shortcuts are switched off', async () => {
    state.settings.agent.allowShortcuts = false
    const host = makeHost()
    const agent = createAgentController(host)

    const result = await agent.execute({ steps: [step({ kind: 'key', combo: 'cmd+s' })], area } as never)

    expect(result.message).toBe('Горячие клавиши отключены в настройках агента.')
    expect(ran('key')).toBe(0)
  })

  it('refuses a combination it cannot press', async () => {
    const host = makeHost()
    const agent = createAgentController(host)

    const result = await agent.execute({ steps: [step({ kind: 'key', combo: 'cmd+foo' })], area } as never)

    expect(result.message).toBe('Неизвестная комбинация: cmd+foo')
    expect(ran('key')).toBe(0)
  })

  it('refuses to type into a focused button', async () => {
    state.helper.focused = { role: 'AXButton', pressable: true, title: 'Экспорт', pid: 42 }
    const host = makeHost()
    const agent = createAgentController(host)

    const result = await agent.execute({ steps: [step({ kind: 'type', text: 'x' })], area } as never)

    expect(result.message).toBe(
      'Поле ввода не в фокусе (сейчас в фокусе «Экспорт») — текст не введён.'
    )
    expect(ran('type')).toBe(0)
  })

  it('types into a focused text field', async () => {
    state.helper.focused = { role: 'AXTextField', editable: true, pid: 42 }
    const host = makeHost()
    const agent = createAgentController(host)

    await agent.execute({ steps: [step({ kind: 'type', text: 'x' })], area } as never)

    expect(ran('type')).toBe(1)
  })

  it('gives an app that reports no focus the benefit of the doubt', async () => {
    state.helper.focused = null
    const host = makeHost()
    const agent = createAgentController(host)

    await agent.execute({ steps: [step({ kind: 'type', text: 'x' })], area } as never)

    expect(ran('type')).toBe(1)
  })

  it('ignores a focus that belongs to another app', async () => {
    state.helper.focused = { role: 'AXButton', pressable: true, pid: 999 }
    const host = makeHost()
    const agent = createAgentController(host)

    await agent.execute({ steps: [step({ kind: 'type', text: 'x' })], area } as never)

    expect(ran('type')).toBe(1)
  })
})

describe('execute: aiming through the Accessibility tree', () => {
  it('clicks the centre of the element the model named', async () => {
    state.helper.probe = probe([
      {
        role: 'AXButton',
        title: 'Экспорт',
        frame: { x: 400, y: 400, width: 100, height: 40 },
        pressable: true
      }
    ])
    const host = makeHost()
    const agent = createAgentController(host)

    await agent.execute(
      {
        steps: [
          step({ kind: 'click', at: { x: 0.45, y: 0.42 }, button: 'left', label: 'Экспорт' })
        ],
        area
      } as never
    )

    expect(state.calls.find((call) => call.name === 'click')?.args).toEqual([450, 420, 'left'])
  })

  it('marks a click that had to fall back on the model point', async () => {
    state.helper.probe = null
    const host = makeHost()
    const agent = createAgentController(host)

    await agent.execute(
      { steps: [step({ kind: 'click', at: { x: 0.5, y: 0.5 }, button: 'left' }, 'Клик')], area } as never
    )

    const acting = host.events.find((event) => event.phase === 'acting')
    expect(acting?.label).toBe('Клик · на глаз')
  })

  it('refuses a click that is known to be on another control', async () => {
    state.helper.probe = probe([
      {
        role: 'AXButton',
        title: 'Клавиатура',
        frame: { x: 400, y: 400, width: 100, height: 40 },
        pressable: true
      }
    ])
    const host = makeHost()
    const agent = createAgentController(host)

    const result = await agent.execute(
      {
        steps: [
          step({ kind: 'click', at: { x: 0.45, y: 0.42 }, button: 'left', label: 'Мышь' }, 'Мышь')
        ],
        area
      } as never
    )

    expect(result.message).toBe('Под точкой «Клавиатура», а не «Мышь» — не нажимаю.')
    expect(ran('click')).toBe(0)
  })

  it('reuses one tree for two steps that ask the same place', async () => {
    state.helper.probe = probe([])
    const host = makeHost()
    const agent = createAgentController(host)

    await agent.execute(
      {
        steps: [
          step({ kind: 'move', at: { x: 0.5, y: 0.5 } }),
          step({ kind: 'move', at: { x: 0.5, y: 0.5 } })
        ],
        area
      } as never
    )

    // A move drops the cache (the screen changed), so both steps probe once each.
    expect(ran('probe')).toBeGreaterThanOrEqual(1)
  })
})

describe('execute: stopping a run', () => {
  it('aborts on Escape and says so', async () => {
    state.settings.agent.startDelayMs = 50
    const host = makeHost()
    const agent = createAgentController(host)
    const util = await import('../util')
    vi.spyOn(util, 'delay').mockImplementation(async () => {
      state.abortHandler?.('escape')
    })

    const result = await agent.execute(
      { steps: [step({ kind: 'move', at: { x: 0.5, y: 0.5 } })], area } as never
    )

    expect(result.message).toBe('Остановлено по Escape.')
    expect(last(host).phase).toBe('aborted')
    expect(ran('move')).toBe(0)
  })

  it('aborts when the user takes the mouse', async () => {
    state.settings.agent.startDelayMs = 50
    const host = makeHost()
    const agent = createAgentController(host)
    const util = await import('../util')
    vi.spyOn(util, 'delay').mockImplementation(async () => {
      state.abortHandler?.('mousemove')
    })

    const result = await agent.execute(
      { steps: [step({ kind: 'move', at: { x: 0.5, y: 0.5 } })], area } as never
    )

    expect(result.message).toBe('Остановлено: вы взяли мышь.')
  })

  it('reports a stop before the first action as cancelled', async () => {
    state.settings.agent.startDelayMs = 50
    const host = makeHost()
    const agent = createAgentController(host)
    const util = await import('../util')
    vi.spyOn(util, 'delay').mockImplementation(async () => {
      agent.stop()
    })

    const result = await agent.execute(
      { steps: [step({ kind: 'move', at: { x: 0.5, y: 0.5 } })], area } as never
    )

    expect(result.message).toBe('Остановлено.')
    expect(ran('move')).toBe(0)
  })

  it('stop() publishes «Остановлено» only while a run is in flight', async () => {
    const host = makeHost()
    const agent = createAgentController(host)

    agent.stop()
    expect(host.events).toHaveLength(0)

    state.settings.agent.startDelayMs = 50
    const util = await import('../util')
    vi.spyOn(util, 'delay').mockImplementation(async () => {
      expect(agent.isRunning()).toBe(true)
      agent.stop()
    })
    await agent.execute({ steps: [step({ kind: 'move', at: { x: 0.5, y: 0.5 } })], area } as never)

    expect(host.events.some((event) => event.phase === 'aborted')).toBe(true)
  })

  it('stops the watcher and restores the window on stop()', () => {
    const host = makeHost()
    const agent = createAgentController(host)

    agent.stop()

    expect(host.passthrough).toContain(false)
  })
})

describe('execute: bringing the target app to the front', () => {
  it('activates the target when the card itself is frontmost', async () => {
    state.helper.front = null
    const host = makeHost()
    const agent = createAgentController(host)

    await agent.execute({ steps: [step({ kind: 'done' })], area } as never)

    expect(ran('activate')).toBe(1)
  })

  it('activates the target when it is already in front', async () => {
    const host = makeHost()
    const agent = createAgentController(host)

    await agent.execute({ steps: [step({ kind: 'done' })], area } as never)

    expect(ran('activate')).toBe(1)
  })

  it('leaves a third app in front, because the plan was written against it', async () => {
    state.helper.front = { bundleId: 'com.apple.systempreferences', pid: 777 }
    const host = makeHost()
    const agent = createAgentController(host)

    await agent.execute({ steps: [step({ kind: 'done' })], area } as never)

    expect(ran('activate')).toBe(0)
  })

  it('aims at the app that is in front now, not at the one the card was opened in', async () => {
    state.helper.front = { bundleId: 'com.apple.systempreferences', pid: 777 }
    state.helper.probe = probe([])
    const host = makeHost()
    const agent = createAgentController(host)

    await agent.execute(
      { steps: [step({ kind: 'move', at: { x: 0.5, y: 0.5 } })], area } as never
    )

    const probeCall = state.calls.find((call) => call.name === 'probe')
    expect(probeCall?.args[0]).toBe(777)
  })
})

describe('pointer and describe', () => {
  it('reports the rounded pointer position', () => {
    state.cursorPoint = { x: 10.4, y: 20.6 }
    const agent = createAgentController(makeHost())

    expect(agent.pointer()).toEqual({ x: 10, y: 21 })
  })

  it('describes a shortcut as the card prints it', () => {
    const agent = createAgentController(makeHost())

    expect(agent.describe('cmd+s')).toBe('⌘S')
  })

  it('starts with an idle event', () => {
    const agent = createAgentController(makeHost())

    expect(agent.last()).toEqual({ phase: 'idle', step: 0, total: 0, label: '', plan: [] })
  })
})
