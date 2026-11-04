import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  settings: {
    gestures: { enabled: true, fingers: 3, holdMs: 400 }
  },
  binary: '/bin/helper' as string | null,
  listenerOptions: null as Record<string, unknown> | null,
  startError: null as string | null,
  listening: true,
  started: 0,
  stopped: 0
}))

vi.mock('../native/helper', () => ({ helperBinary: () => state.binary }))

vi.mock('../settings/store', () => ({ getSettings: () => state.settings }))

vi.mock('./listen', () => ({
  TrackpadGestureListener: class {
    constructor(options: Record<string, unknown>) {
      state.listenerOptions = options
    }
    get listening(): boolean {
      return state.listening
    }
    start(): string | null {
      state.started += 1
      return state.startError
    }
    stop(): void {
      state.stopped += 1
    }
    emit(event: string): void {
      const handler = state.listenerOptions?.onEvent as (event: string) => void
      handler(event)
    }
    fail(message: string): void {
      const handler = state.listenerOptions?.onError as (message: string) => void
      handler(message)
    }
  }
}))

import { createGestureController } from './index'

function makeHost() {
  const host = {
    opened: 0,
    openResult: false,
    pressed: 0,
    released: 0,
    cancelled: 0,
    isOpen: () => host.openResult,
    open: async () => {
      host.opened += 1
    },
    press: () => {
      host.pressed += 1
    },
    release: () => {
      host.released += 1
    },
    cancel: () => {
      host.cancelled += 1
    }
  }
  return host
}

beforeEach(() => {
  state.settings = { gestures: { enabled: true, fingers: 3, holdMs: 400 } }
  state.binary = '/bin/helper'
  state.listenerOptions = null
  state.startError = null
  state.listening = true
  state.started = 0
  state.stopped = 0
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
})

describe('createGestureController: routing an event', () => {
  it('opens the card on a tap', () => {
    const host = makeHost()
    const gesture = createGestureController(host)
    gesture.applySettings()

    ;(state.listenerOptions?.onEvent as (event: string) => void)('tap')

    expect(host.opened).toBe(1)
  })

  it('does not rebuild a card that is already open on a tap', () => {
    const host = makeHost()
    host.openResult = true
    const gesture = createGestureController(host)
    gesture.applySettings()

    ;(state.listenerOptions?.onEvent as (event: string) => void)('tap')

    expect(host.opened).toBe(0)
  })

  it('ignores `ready`', () => {
    const host = makeHost()
    const gesture = createGestureController(host)
    gesture.applySettings()

    ;(state.listenerOptions?.onEvent as (event: string) => void)('ready')

    expect(host.opened).toBe(0)
    expect(host.pressed).toBe(0)
  })

  it('routes press, release and cancel into the voice state machine', () => {
    const host = makeHost()
    const gesture = createGestureController(host)
    gesture.applySettings()
    const emit = state.listenerOptions?.onEvent as (event: string) => void

    emit('press')
    emit('release')
    emit('cancel')

    expect(host.pressed).toBe(1)
    expect(host.released).toBe(1)
    expect(host.cancelled).toBe(1)
  })

  it('treats an unknown event as a cancel', () => {
    const host = makeHost()
    const gesture = createGestureController(host)
    gesture.applySettings()

    ;(state.listenerOptions?.onEvent as (event: string) => void)('weird')

    expect(host.cancelled).toBe(1)
  })
})

describe('createGestureController: settings', () => {
  it('does nothing while gestures are switched off', () => {
    state.settings = { gestures: { enabled: false, fingers: 3, holdMs: 400 } }
    const gesture = createGestureController(makeHost())

    gesture.applySettings()

    expect(state.listenerOptions).toBeNull()
    expect(gesture.status()).toEqual({ gestureError: null, listening: false })
  })

  it('stops a running listener when gestures are switched off', () => {
    const gesture = createGestureController(makeHost())
    gesture.applySettings()
    state.settings = { gestures: { enabled: false, fingers: 3, holdMs: 400 } }

    gesture.applySettings()

    expect(state.stopped).toBe(1)
    expect(gesture.status().listening).toBe(false)
  })

  it('reports a missing helper', () => {
    state.binary = null
    const gesture = createGestureController(makeHost())

    gesture.applySettings()

    expect(state.listenerOptions).toBeNull()
    expect(gesture.status().gestureError).toBe(
      'Нативный helper не найден — жесты тремя пальцами недоступны.'
    )
  })

  it('reuses a listener whose configuration did not change', () => {
    const gesture = createGestureController(makeHost())
    gesture.applySettings()
    const first = state.listenerOptions
    gesture.applySettings()

    expect(state.listenerOptions).toBe(first)
    expect(state.started).toBe(1)
  })

  it('restarts the listener when the finger count changes', () => {
    const gesture = createGestureController(makeHost())
    gesture.applySettings()
    state.settings = { gestures: { enabled: true, fingers: 4, holdMs: 400 } }

    gesture.applySettings()

    expect(state.started).toBe(2)
    expect(state.stopped).toBe(1)
  })

  it('restarts the listener when the hold threshold changes', () => {
    const gesture = createGestureController(makeHost())
    gesture.applySettings()
    state.settings = { gestures: { enabled: true, fingers: 3, holdMs: 900 } }

    gesture.applySettings()

    expect(state.started).toBe(2)
  })

  it('restarts a listener that is no longer running even without a change', () => {
    const gesture = createGestureController(makeHost())
    gesture.applySettings()
    state.listening = false

    gesture.applySettings()

    expect(state.started).toBe(2)
  })

  it('surfaces a start error in the status', () => {
    state.startError = 'Трекпад не найден.'
    const gesture = createGestureController(makeHost())

    gesture.applySettings()

    expect(gesture.status().gestureError).toBe('Трекпад не найден.')
  })

  it('surfaces a listener error in the status', () => {
    const gesture = createGestureController(makeHost())
    gesture.applySettings()

    ;(state.listenerOptions?.onError as (message: string) => void)('нет трекпада')

    expect(gesture.status().gestureError).toBe('нет трекпада')
  })

  it('stop() kills the listener and forgets the configuration', () => {
    const gesture = createGestureController(makeHost())
    gesture.applySettings()

    gesture.stop()

    expect(state.stopped).toBe(1)
    expect(gesture.status().listening).toBe(false)
    // Nothing to reuse: the next applySettings starts a fresh listener.
    gesture.applySettings()
    expect(state.started).toBe(2)
  })
})
