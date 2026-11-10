import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ActiveAppInfo, VoicePhase } from '@shared/types'

/** A settings object with only the voice section meaningful. */
function settings(overrides: Record<string, unknown> = {}): { voice: Record<string, unknown> } {
  return {
    voice: {
      enabled: true,
      hotkey: 'Alt+Shift+Space',
      model: 'small-q5_1',
      language: 'ru',
      action: 'command',
      autoSend: true,
      minDurationMs: 300,
      maxDurationMs: 120_000,
      ...overrides
    }
  }
}

const state = vi.hoisted(() => ({
  settings: { voice: {} } as { voice: Record<string, unknown> },
  binary: '/bin/helper' as string | null,
  /** Controllable clock: `Date.now()` is spied, never faked. */
  now: 1_000_000,
  /** What the tap listener does when it starts. */
  startError: null as string | null,
  listenerOptions: null as Record<string, unknown> | null,
  stopped: 0,
  pasted: [] as Array<{ text: string; target: ActiveAppInfo | null }>,
  transcribed: null as
    | null
    | ((options: { wav: Buffer }) => Promise<{ ok: boolean; text: string; ms: number; message?: string }>)
}))

vi.mock('../native/helper', () => ({ helperBinary: () => state.binary }))

vi.mock('../settings/store', () => ({ getSettings: () => state.settings }))

vi.mock('../paste', () => ({
  pasteAnswer: async (text: string, target: ActiveAppInfo | null) => {
    state.pasted.push({ text, target })
    return { ok: true, copiedOnly: false }
  }
}))

vi.mock('./recognizer', () => ({
  transcribe: (options: { wav: Buffer }) =>
    state.transcribed?.(options) ?? Promise.resolve({ ok: true, text: 'привет', ms: 5 }),
  voiceStatus: async () => ({
    ready: true,
    detail: null,
    modelPath: '/m',
    binaryPath: '/b',
    modelsDir: '/d',
    installed: [],
    listenerError: null
  })
}))

vi.mock('./listen', () => ({
  VoiceKeyListener: class {
    listening = true
    lastError: string | null = null
    constructor(options: Record<string, unknown>) {
      state.listenerOptions = options
    }
    start(accelerator: string): string | null {
      void accelerator
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

import { createVoiceController } from './index'

function makeHost() {
  const host = {
    emitted: [] as Array<{ channel: string; payload: unknown }>,
    voice: [] as boolean[],
    opened: 0,
    openResult: true,
    delivered: [] as Array<{ text: string; send: boolean }>,
    hidden: 0,
    targetValue: null as ActiveAppInfo | null,
    prewarmed: 0,
    target: () => host.targetValue,
    isOpen: () => host.openResult,
    showIndicator: () => {},
    prewarm: () => {
      host.prewarmed += 1
    },
    open: async () => {
      host.opened += 1
    },
    deliver: (text: string, send: boolean) => {
      host.delivered.push({ text, send })
    },
    hide: () => {
      host.hidden += 1
    },
    emit: (channel: string, payload: unknown) => {
      host.emitted.push({ channel, payload })
    },
    setVoice: (active: boolean) => {
      host.voice.push(active)
    }
  }
  return host
}

type Host = ReturnType<typeof makeHost>

/** Phase events only: `voice:record` and `voice:stop` carry no phase. */
function phases(host: Host): VoicePhase[] {
  return host.emitted
    .filter((event) => event.channel === 'voice:event')
    .map((event) => (event.payload as { phase: VoicePhase }).phase)
}

function lastEvent(host: Host): { phase: VoicePhase; text?: string; error?: string; level: number } {
  return host.emitted[host.emitted.length - 1].payload as {
    phase: VoicePhase
    text?: string
    error?: string
    level: number
  }
}

beforeEach(() => {
  state.settings = settings()
  state.binary = '/bin/helper'
  state.now = 1_000_000
  state.startError = null
  state.listenerOptions = null
  state.stopped = 0
  state.pasted = []
  state.transcribed = null
  vi.spyOn(Date, 'now').mockImplementation(() => state.now)
  vi.useFakeTimers({
    toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval']
  })
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('createVoiceController: press and release', () => {
  it('starts recording, turns the glass off and asks the renderer to record', async () => {
    const host = makeHost()
    const voice = createVoiceController(host)
    voice.applySettings()

    voice.press()

    expect(voice.phase()).toBe('listening')
    expect(host.voice).toEqual([true])
    expect(host.emitted).toContainEqual({
      channel: 'voice:record',
      payload: { maxDurationMs: 120_000 }
    })
  })

  it('opens the card when it is not on screen', async () => {
    const host = makeHost()
    host.openResult = false
    const voice = createVoiceController(host)
    voice.applySettings()

    voice.press()
    await vi.advanceTimersByTimeAsync(0)

    expect(host.opened).toBe(1)
  })

  it('does not open the card twice when it is already on screen', () => {
    const host = makeHost()
    host.openResult = true
    const voice = createVoiceController(host)
    voice.applySettings()

    voice.press()

    expect(host.opened).toBe(0)
  })

  it('stops a card that refused to open, and ends the turn', async () => {
    const host = makeHost()
    host.openResult = false
    host.open = async () => {
      host.opened += 1
      host.openResult = false
    }
    const voice = createVoiceController(host)
    voice.applySettings()

    voice.press()
    await vi.advanceTimersByTimeAsync(0)

    expect(host.emitted).toContainEqual({ channel: 'voice:stop', payload: { transcribe: false } })
    expect(voice.phase()).toBe('idle')
  })

  it('ignores a second press while already listening', () => {
    const host = makeHost()
    const voice = createVoiceController(host)
    voice.applySettings()

    voice.press()
    const records = host.emitted.filter((event) => event.channel === 'voice:record').length
    voice.press()

    expect(host.emitted.filter((event) => event.channel === 'voice:record')).toHaveLength(records)
  })

  it('refuses a press when voice is switched off', () => {
    state.settings = settings({ enabled: false })
    const host = makeHost()
    const voice = createVoiceController(host)
    voice.applySettings()

    voice.press()

    expect(voice.phase()).toBe('idle')
    expect(host.emitted).toHaveLength(0)
  })

  it('treats a tap shorter than minDurationMs as a mistake and records nothing', () => {
    const host = makeHost()
    const voice = createVoiceController(host)
    voice.applySettings()
    voice.press()

    state.now += 100
    voice.release()

    expect(host.emitted).toContainEqual({ channel: 'voice:stop', payload: { transcribe: false } })
    expect(voice.phase()).toBe('idle')
  })

  it('moves to transcribing and keeps the samples on a long enough hold', () => {
    const host = makeHost()
    const voice = createVoiceController(host)
    voice.applySettings()
    voice.press()

    state.now += 500
    voice.release()

    expect(voice.phase()).toBe('transcribing')
    expect(host.emitted).toContainEqual({ channel: 'voice:stop', payload: { transcribe: true } })
  })

  it('reads minDurationMs at release time, not at press time', () => {
    const host = makeHost()
    const voice = createVoiceController(host)
    voice.applySettings()
    voice.press()

    state.settings = settings({ minDurationMs: 900 })
    state.now += 500
    voice.release()

    expect(voice.phase()).toBe('idle')
  })

  it('ignores a release when nothing is being recorded', () => {
    const host = makeHost()
    const voice = createVoiceController(host)
    voice.applySettings()

    voice.release()

    expect(host.emitted).toHaveLength(0)
  })
})

describe('createVoiceController: recognition', () => {
  async function listening(): Promise<{ host: Host; voice: ReturnType<typeof createVoiceController> }> {
    const host = makeHost()
    const voice = createVoiceController(host)
    voice.applySettings()
    voice.press()
    state.now += 500
    voice.release()
    return { host, voice }
  }

  it('delivers the transcript to the card and ends the turn', async () => {
    const { host, voice } = await listening()

    const result = await voice.handleRecording({ wavBase64: 'AAAA', durationMs: 800 })

    expect(result).toMatchObject({ ok: true, text: 'привет' })
    expect(host.delivered).toEqual([{ text: 'привет', send: true }])
    expect(voice.phase()).toBe('idle')
    expect(lastEvent(host).text).toBe('привет')
  })

  it('honours autoSend=false', async () => {
    state.settings = settings({ autoSend: false })
    const { host, voice } = await listening()

    await voice.handleRecording({ wavBase64: 'AAAA', durationMs: 800 })

    expect(host.delivered).toEqual([{ text: 'привет', send: false }])
  })

  it('pastes into the target app for dictation, and hides the card', async () => {
    state.settings = settings({ action: 'dictate' })
    const target: ActiveAppInfo = {
      bundleId: 'com.apple.TextEdit',
      name: 'TextEdit',
      pid: 9,
      windowTitle: null,
      windowId: null,
      bounds: null
    }
    const { host, voice } = await listening()
    host.targetValue = target

    await voice.handleRecording({ wavBase64: 'AAAA', durationMs: 800 })

    expect(state.pasted).toEqual([{ text: 'привет', target }])
    expect(host.delivered).toEqual([])
    expect(host.hidden).toBeGreaterThan(0)
  })

  it('refuses a recording that arrives outside `transcribing`', async () => {
    const host = makeHost()
    const voice = createVoiceController(host)
    voice.applySettings()

    const result = await voice.handleRecording({ wavBase64: 'AAAA', durationMs: 800 })

    expect(result).toEqual({ ok: false, text: '', ms: 0, message: 'Пропущено.' })
    expect(host.emitted).toHaveLength(0)
  })

  it('reports a missing recorder as a microphone problem', async () => {
    const { host, voice } = await listening()

    const result = await voice.handleRecording(null)

    expect(result.message).toBe('Запись не удалась.')
    expect(lastEvent(host).error).toBe('Запись не удалась — микрофон недоступен.')
    expect(voice.phase()).toBe('idle')
  })

  it('treats an empty recording as silence, not as a failure', async () => {
    const { host, voice } = await listening()

    const result = await voice.handleRecording({ wavBase64: '', durationMs: 800 })

    expect(result.message).toBe('Речь не распознана.')
    expect(lastEvent(host).error).toBe('Ничего не расслышал — попробуйте ещё раз.')
    expect(voice.phase()).toBe('idle')
  })

  it('reports a failed recognition with its own message', async () => {
    state.transcribed = async () => ({ ok: false, text: '', ms: 3, message: 'Речь не распознана.' })
    const { host, voice } = await listening()

    await voice.handleRecording({ wavBase64: 'AAAA', durationMs: 800 })

    expect(lastEvent(host).error).toBe('Речь не распознана.')
    expect(voice.phase()).toBe('idle')
  })

  it('reports a throwing recogniser', async () => {
    state.transcribed = async () => {
      throw new Error('whisper-cli упал')
    }
    const { host, voice } = await listening()

    const result = await voice.handleRecording({ wavBase64: 'AAAA', durationMs: 800 })

    expect(result.message).toBe('whisper-cli упал')
    expect(lastEvent(host).error).toBe('whisper-cli упал')
  })

  it('decodes the base64 payload into a Buffer', async () => {
    const seen: Buffer[] = []
    state.transcribed = async ({ wav }) => {
      seen.push(wav)
      return { ok: true, text: 'ок', ms: 1 }
    }
    const { voice } = await listening()

    await voice.handleRecording({ wavBase64: Buffer.from('RIFF').toString('base64'), durationMs: 1 })

    expect(seen[0].toString()).toBe('RIFF')
  })

  it('discards a result whose turn was superseded by a new press', async () => {
    let release = (): void => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    state.transcribed = async () => {
      await gate
      return { ok: true, text: 'старая фраза', ms: 1 }
    }
    const { host, voice } = await listening()

    const pending = voice.handleRecording({ wavBase64: 'AAAA', durationMs: 800 })
    voice.press()
    release()
    await pending

    expect(host.delivered).toEqual([])
    // The new turn is still the one on the card: a late result must not end it.
    expect(voice.phase()).toBe('listening')
  })

  it('reports busy while a turn runs', async () => {
    const { voice } = await listening()

    expect(voice.isBusy()).toBe(true)
    await voice.handleRecording({ wavBase64: 'AAAA', durationMs: 800 })
    expect(voice.isBusy()).toBe(false)
  })
})

describe('createVoiceController: cancel and failures', () => {
  it('cancels a running recording without transcribing', () => {
    const host = makeHost()
    const voice = createVoiceController(host)
    voice.applySettings()
    voice.press()

    voice.cancel()

    expect(host.emitted).toContainEqual({ channel: 'voice:stop', payload: { transcribe: false } })
    expect(voice.phase()).toBe('idle')
  })

  it('cancels a turn that is already transcribing', async () => {
    const host = makeHost()
    const voice = createVoiceController(host)
    voice.applySettings()
    voice.press()
    state.now += 500
    voice.release()

    voice.cancel()

    expect(voice.phase()).toBe('idle')
  })

  it('reports the listener error on cancel', () => {
    const host = makeHost()
    state.startError = 'Комбинация «x» не подходит для удержания.'
    const voice = createVoiceController(host)
    voice.applySettings()

    voice.cancel()

    expect(lastEvent(host).error).toBe('Комбинация «x» не подходит для удержания.')
  })

  it('reports a recorder failure', () => {
    const host = makeHost()
    const voice = createVoiceController(host)
    voice.applySettings()
    voice.press()

    voice.failed('Микрофон недоступен')

    expect(lastEvent(host).error).toBe('Микрофон недоступен')
    expect(voice.phase()).toBe('idle')
  })

  it('ignores ready and reenabled taps', () => {
    const host = makeHost()
    const voice = createVoiceController(host)
    voice.applySettings()
    const emit = state.listenerOptions?.onEvent as (event: string) => void

    emit('ready')
    emit('reenabled')

    expect(host.emitted).toHaveLength(0)
  })

  it('forwards a listener error into the status', async () => {
    const host = makeHost()
    const voice = createVoiceController(host)
    voice.applySettings()

    ;(state.listenerOptions?.onError as (message: string) => void)('нет прав')

    expect((await voice.status()).listenerError).toBe('нет прав')
  })
})

describe('createVoiceController: the level meter', () => {
  it('clamps a level to 0..1 and republishes it', () => {
    const host = makeHost()
    const voice = createVoiceController(host)
    voice.applySettings()
    voice.press()

    // The level is published by the 10 Hz tick, not by the call itself.
    voice.setLevel(2)
    vi.advanceTimersByTime(100)
    expect(lastEvent(host).level).toBe(1)

    voice.setLevel(-1)
    vi.advanceTimersByTime(100)
    expect(lastEvent(host).level).toBe(0)

    voice.setLevel(0.4)
    vi.advanceTimersByTime(100)
    expect(lastEvent(host).level).toBe(0.4)
  })

  it('ignores a level tick outside `listening`', () => {
    const host = makeHost()
    const voice = createVoiceController(host)
    voice.applySettings()

    voice.setLevel(0.8)

    expect(host.emitted).toHaveLength(0)
  })

  it('republishes the current phase at 10 Hz while a turn runs', () => {
    const host = makeHost()
    const voice = createVoiceController(host)
    voice.applySettings()
    voice.press()

    const before = host.emitted.length
    vi.advanceTimersByTime(300)

    expect(host.emitted.length).toBeGreaterThan(before + 1)
    expect(phases(host).every((phase) => phase === 'listening')).toBe(true)
  })
})

describe('createVoiceController: the watchdogs', () => {
  it('closes a listening turn that outstays maxDurationMs', () => {
    state.settings = settings({ maxDurationMs: 1000 })
    const host = makeHost()
    const voice = createVoiceController(host)
    voice.applySettings()
    voice.press()

    state.now += 1500
    vi.advanceTimersByTime(300)

    expect(voice.phase()).toBe('idle')
    expect(lastEvent(host).error).toBe('Запись остановлена: слишком долго.')
    expect(host.emitted).toContainEqual({ channel: 'voice:stop', payload: { transcribe: false } })
  })

  it('reads maxDurationMs on every tick, not at press time', () => {
    const host = makeHost()
    const voice = createVoiceController(host)
    voice.applySettings()
    voice.press()

    state.settings = settings({ maxDurationMs: 500 })
    state.now += 800
    vi.advanceTimersByTime(300)

    expect(voice.phase()).toBe('idle')
  })

  it('does not close a listening turn before the ceiling', () => {
    state.settings = settings({ maxDurationMs: 10_000 })
    const host = makeHost()
    const voice = createVoiceController(host)
    voice.applySettings()
    voice.press()

    state.now += 500
    vi.advanceTimersByTime(1000)

    expect(voice.phase()).toBe('listening')
  })

  it('closes a turn whose recording never came back', () => {
    const host = makeHost()
    const voice = createVoiceController(host)
    voice.applySettings()
    voice.press()
    state.now += 500
    voice.release()

    vi.advanceTimersByTime(5000)

    expect(voice.phase()).toBe('idle')
    expect(lastEvent(host).error).toBe('Запись не дошла до распознавания — попробуйте ещё раз.')
  })

  it('closes a turn whose recognition hangs, with the longer budget', async () => {
    state.transcribed = () => new Promise(() => undefined)
    const host = makeHost()
    const voice = createVoiceController(host)
    voice.applySettings()
    voice.press()
    state.now += 500
    voice.release()

    void voice.handleRecording({ wavBase64: 'AAAA', durationMs: 800 })
    await vi.advanceTimersByTimeAsync(30_000)

    expect(voice.phase()).toBe('idle')
    expect(lastEvent(host).error).toBe('Распознавание не ответило — попробуйте ещё раз.')
  })

  it('drops the watchdog of a superseded turn', () => {
    const host = makeHost()
    const voice = createVoiceController(host)
    voice.applySettings()
    voice.press()
    state.now += 500
    voice.release()

    voice.press()
    vi.advanceTimersByTime(6000)

    expect(voice.phase()).toBe('listening')
  })
})

describe('createVoiceController: settings and lifecycle', () => {
  it('reports a missing helper instead of starting a listener', () => {
    state.binary = null
    const host = makeHost()
    const voice = createVoiceController(host)

    voice.applySettings()

    expect(state.listenerOptions).toBeNull()
    expect(host.prewarmed).toBe(0)
  })

  it('stops the listener when voice is switched off', () => {
    state.settings = settings({ enabled: false })
    const host = makeHost()
    const voice = createVoiceController(host)

    voice.applySettings()

    expect(state.stopped).toBe(1)
  })

  it('prewarms the card once the tap is up', () => {
    const host = makeHost()
    const voice = createVoiceController(host)

    voice.applySettings()

    expect(host.prewarmed).toBe(1)
  })

  it('does not prewarm when the combination was refused', () => {
    state.startError = 'Комбинация «space» не подходит для удержания.'
    const host = makeHost()
    const voice = createVoiceController(host)

    voice.applySettings()

    expect(host.prewarmed).toBe(0)
  })

  it('reuses one listener across repeated calls', () => {
    const host = makeHost()
    const voice = createVoiceController(host)

    voice.applySettings()
    const first = state.listenerOptions
    voice.applySettings()

    expect(state.listenerOptions).toBe(first)
  })

  it('reports the mode the overlay needs', () => {
    const host = makeHost()
    const voice = createVoiceController(host)
    voice.applySettings()

    expect(voice.mode()).toEqual({
      enabled: true,
      action: 'command',
      hotkey: 'Alt+Shift+Space'
    })
  })

  it('tells a freshly mounted card what phase to show', () => {
    const host = makeHost()
    const voice = createVoiceController(host)
    voice.applySettings()
    voice.press()

    expect(voice.attach()).toEqual({ phase: 'listening', maxDurationMs: 120_000 })
  })

  it('stop() puts everything back to idle', () => {
    const host = makeHost()
    const voice = createVoiceController(host)
    voice.applySettings()
    voice.press()

    voice.stop()

    expect(voice.phase()).toBe('idle')
    expect(voice.isBusy()).toBe(false)
    expect(state.stopped).toBe(1)
  })

  it('stop() clears the timers, so nothing fires afterwards', () => {
    const host = makeHost()
    const voice = createVoiceController(host)
    voice.applySettings()
    voice.press()

    voice.stop()
    const emitted = host.emitted.length
    state.now += 500_000
    vi.advanceTimersByTime(60_000)

    expect(host.emitted).toHaveLength(emitted)
  })
})

describe('voice indicator presentation', () => {
  it('chooses a fresh session before revealing the old window', () => {
    const host = makeHost()
    const calls: string[] = []
    host.isOpen = () => { calls.push('isOpen'); return false }
    host.open = async () => { calls.push('open') }
    host.showIndicator = () => { calls.push('indicator') }
    const voice = createVoiceController(host)
    voice.press()
    expect(calls).toEqual(['isOpen', 'open', 'indicator'])
    voice.cancel()
  })

  it('reveals each press even when a card or previous recognition is already open', () => {
    const host = makeHost()
    const indicator = vi.fn()
    host.showIndicator = indicator
    const voice = createVoiceController(host)
    voice.press()
    state.now += 400
    voice.release()
    voice.press()
    expect(indicator).toHaveBeenCalledTimes(2)
    expect(host.opened).toBe(0)
    voice.cancel()
  })
})
