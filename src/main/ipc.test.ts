import { describe, expect, it, vi } from 'vitest'

import { CH } from '@shared/ipc'

/**
 * The IPC surface has two halves that must agree: `registerIpc` wires channels to
 * handlers in the main process, and the preload bridge exposes them to renderers.
 * A channel with no handler is a button that does nothing; a preload method with
 * no channel is a runtime `undefined` in a page. Neither shows up in typecheck,
 * because both sides are typed by hand against `DeskhandApi`.
 *
 * Electron, the store and the helper are mocked: no window, no Keychain, no
 * binary, no network.
 */

const electron = vi.hoisted(() => {
  const handles = new Map<string, (...args: unknown[]) => unknown>()
  const ons = new Map<string, (...args: unknown[]) => unknown>()
  const sent: Array<{ channel: string; payload: unknown }> = []
  return {
    handles,
    ons,
    sent,
    reset(): void {
      handles.clear()
      ons.clear()
      sent.length = 0
    }
  }
})

vi.mock('electron', () => ({
  app: {
    on: () => undefined,
    isReady: () => true,
    getPath: () => '/tmp',
    getAppPath: () => '/app'
  },
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
      electron.handles.set(channel, handler)
    },
    on: (channel: string, handler: (...args: unknown[]) => unknown) => {
      electron.ons.set(channel, handler)
    }
  },
  dialog: {
    showOpenDialog: async () => ({ canceled: true, filePaths: [] })
  },
  shell: {
    openExternal: async () => undefined,
    openPath: async () => ''
  },
  systemPreferences: {
    isTrustedAccessibilityClient: () => false,
    getMediaAccessStatus: () => 'denied',
    askForMediaAccess: async () => false
  },
  desktopCapturer: { getSources: async () => [] },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: () => Buffer.from(''),
    decryptString: () => ''
  },
  BrowserWindow: class {},
  globalShortcut: {
    register: () => true,
    unregister: () => undefined,
    isRegistered: () => false
  },
  nativeTheme: { shouldUseDarkColors: false, on: () => undefined },
  Tray: class {},
  Menu: { buildFromTemplate: () => ({ popup: () => undefined }) },
  screen: { getCursorScreenPoint: () => ({ x: 0, y: 0 }), getDisplayNearestPoint: () => ({}) }
}))

vi.mock('electron-store', () => {
  class FakeStore {
    private data: Record<string, unknown> = {}
    get(key: string): unknown {
      // `secrets.ts` reads `secrets` and spreads it; an empty store must answer
      // with an empty map rather than with `undefined`.
      if (key === 'secrets') return this.data[key] ?? {}
      return this.data[key]
    }
    set(key: string, value: unknown): void {
      this.data[key] = value
    }
  }
  return { default: FakeStore }
})

vi.mock('./settings/store', async () => {
  const { DEFAULT_SETTINGS } = await import('@shared/defaults')
  return {
    getSettings: () => DEFAULT_SETTINGS,
    patchSettings: (patch: Partial<typeof DEFAULT_SETTINGS>) => ({ ...DEFAULT_SETTINGS, ...patch }),
    storeRecovered: () => false
  }
})

vi.mock('./windows', () => ({
  openSettingsWindow: () => undefined,
  closeSettingsWindow: () => undefined,
  closeOnboardingWindow: () => undefined,
  setSettingsHeld: () => undefined,
  showActiveWindow: () => undefined
}))

vi.mock('./native/helper', () => ({
  helperRunningApps: async () => [],
  helperPermissions: async () => ({ accessibility: false, screenRecording: false, microphone: false }),
  helperFrontWindow: async () => null,
  helperFrontApplication: async () => null,
  helperBinary: () => null
}))

vi.mock('./voice/recognizer', () => ({
  downloadModel: async () => undefined,
  importModel: async () => 'tiny',
  deleteModel: async () => undefined,
  voiceStatus: async () => ({ ready: true, model: 'tiny', detail: null })
}))

vi.mock('./llm/testKey', () => ({ testApiKey: async () => ({ ok: true }) }))

import { registerIpc, type IpcDeps } from './ipc'

/** Every method of `IpcDeps`, each a spy: the wiring is what is under test. */
function fakeDeps(): IpcDeps {
  return {
    overlay: {
      state: vi.fn(() => null),
      send: vi.fn(async () => undefined),
      cancel: vi.fn(),
      setFlags: vi.fn(),
      clearPointer: vi.fn(),
      setTyping: vi.fn(),
      resize: vi.fn(),
      close: vi.fn(),
      copy: vi.fn(async () => undefined),
      paste: vi.fn(async () => ({ ok: true, method: 'paste' })),
      agentAvailability: vi.fn(() => ({ enabled: false, ready: false, reason: null })),
      setAgentEnabled: vi.fn(() => ({ enabled: true, ready: false, reason: null })),
      stopAgent: vi.fn(),
      answerAgent: vi.fn(),
      disposeAgent: vi.fn(),
      open: vi.fn(async () => undefined)
    } as unknown as IpcDeps['overlay'],
    voice: {
      applySettings: vi.fn(),
      status: vi.fn(async () => ({ phase: 'idle', ready: true })),
      attach: vi.fn(async () => ({ phase: 'idle', maxDurationMs: 30_000 })),
      handleRecording: vi.fn(async () => ({ ok: true, text: '', ms: 0 })),
      failed: vi.fn(),
      setLevel: vi.fn()
    } as unknown as IpcDeps['voice'],
    applyHotkey: vi.fn(() => true),
    applyLaunchAtLogin: vi.fn(),
    setRecording: vi.fn(),
    quit: vi.fn()
  }
}

/** Flattens the nested `CH` map into `path -> channel` pairs. */
function flatten(node: unknown, prefix = ''): Array<[string, string]> {
  const out: Array<[string, string]> = []
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${key}` : key
    if (typeof value === 'string') out.push([path, value])
    else out.push(...flatten(value, path))
  }
  return out
}

const channels = flatten(CH)

/** Channels the main process only ever *sends* on: nothing to handle here. */
const MAIN_TO_RENDERER = new Set<string>([
  CH.overlay.state,
  CH.overlay.preparing,
  CH.overlay.contextUpdate,
  CH.overlay.stream,
  CH.overlay.annotations,
  CH.pointer.draw,
  CH.agent.event,
  CH.agent.cursor,
  CH.agent.presentation,
  CH.voice.event,
  CH.voice.record,
  CH.voice.stop,
  CH.voice.transcript,
  CH.voice.downloadProgress
])

function wire(): void {
  electron.reset()
  registerIpc(fakeDeps())
}

describe('registerIpc: every channel has exactly one handler', () => {
  it('handles or deliberately ignores each channel, and nothing else', () => {
    wire()
    const wired = new Set([...electron.handles.keys(), ...electron.ons.keys()])

    const missing = channels
      .filter(([, channel]) => !MAIN_TO_RENDERER.has(channel))
      .filter(([, channel]) => !wired.has(channel))
      .map(([path, channel]) => `${path} (${channel})`)

    expect(missing).toEqual([])
  })

  it('wires no channel that is not in the shared map', () => {
    wire()
    const known = new Set(channels.map(([, channel]) => channel))
    const extra = [...electron.handles.keys(), ...electron.ons.keys()].filter(
      (channel) => !known.has(channel)
    )
    expect(extra).toEqual([])
  })

  it('never registers one channel twice', () => {
    wire()
    const all = [...electron.handles.keys(), ...electron.ons.keys()]
    expect(new Set(all).size).toBe(all.length)
  })

  it('uses invoke for request/response and send for fire-and-forget', () => {
    wire()
    // A pull that a renderer awaits must be `handle`; a push must be `on`.
    for (const channel of [
      CH.overlay.getState,
      CH.overlay.copy,
      CH.overlay.paste,
      CH.settings.load,
      CH.settings.save,
      CH.permissions.status,
      CH.agent.availability,
      CH.voice.status
    ]) {
      expect(electron.handles.has(channel), channel).toBe(true)
      expect(electron.ons.has(channel), channel).toBe(false)
    }
    for (const channel of [
      CH.overlay.send,
      CH.overlay.cancel,
      CH.overlay.close,
      CH.overlay.resize,
      CH.settings.open,
      CH.settings.hold,
      CH.permissions.open,
      CH.onboarding.openSettings,
      CH.voice.level,
      CH.voice.failed
    ]) {
      expect(electron.ons.has(channel), channel).toBe(true)
      expect(electron.handles.has(channel), channel).toBe(false)
    }
  })
})

describe('registerIpc: the handlers reach their dependency', () => {
  it('routes overlay pushes to the overlay controller', () => {
    const deps = fakeDeps()
    electron.reset()
    registerIpc(deps)

    const send = electron.ons.get(CH.overlay.send)!
    send({}, { requestId: 'r1', text: 'привет' })
    expect(deps.overlay.send).toHaveBeenCalledWith({ requestId: 'r1', text: 'привет' })

    electron.ons.get(CH.overlay.cancel)!({}, 'r1')
    expect(deps.overlay.cancel).toHaveBeenCalledWith('r1')

    electron.ons.get(CH.overlay.typing)!({}, 1)
    // Coerced, not passed through: the renderer is not trusted with the type.
    expect(deps.overlay.setTyping).toHaveBeenCalledWith(true)

    electron.ons.get(CH.overlay.resize)!({}, 120, 360)
    expect(deps.overlay.resize).toHaveBeenCalledWith(120, 360, false)

    // A drag pins the left edge; anything else is coerced, because the renderer
    // is not trusted with the type.
    electron.ons.get(CH.overlay.resize)!({}, 120, 480, true)
    expect(deps.overlay.resize).toHaveBeenCalledWith(120, 480, true)
    electron.ons.get(CH.overlay.resize)!({}, 120, 480, 'yes')
    expect(deps.overlay.resize).toHaveBeenCalledWith(120, 480, true)
  })

  it('answers the agent availability question from the overlay', async () => {
    const deps = fakeDeps()
    electron.reset()
    registerIpc(deps)

    const availability = electron.handles.get(CH.agent.availability)!
    expect(await availability()).toEqual({ enabled: false, ready: false, reason: null })

    const setEnabled = electron.handles.get(CH.agent.setEnabled)!
    await setEnabled({}, true)
    expect(deps.overlay.setAgentEnabled).toHaveBeenCalledWith(true)
  })

  it('passes one answered question through, and drops a malformed one', async () => {
    const deps = fakeDeps()
    electron.reset()
    registerIpc(deps)

    const answer = electron.handles.get(CH.agent.answer)!
    await answer({}, 'call-1', true, true)
    expect(deps.overlay.answerAgent).toHaveBeenCalledWith('call-1', true, true)

    // Anything that is not a real id is ignored: the run compares the id against
    // the question it is blocked on, and a stray value must not reach it at all.
    await answer({}, undefined, true, false)
    await answer({}, '', true, false)
    expect(deps.overlay.answerAgent).toHaveBeenCalledTimes(1)

    // Non-booleans are coerced to "no", never to "yes": a renderer bug must not
    // be able to turn an unanswered question into permission.
    await answer({}, 'call-2', 'yes', 1)
    expect(deps.overlay.answerAgent).toHaveBeenLastCalledWith('call-2', false, false)
  })

  it('reports copy failures instead of throwing into the renderer', async () => {
    const deps = fakeDeps()
    ;(deps.overlay.copy as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('clipboard busy')
    )
    electron.reset()
    registerIpc(deps)

    const copy = electron.handles.get(CH.overlay.copy)!
    expect(await copy({}, 'текст')).toEqual({ ok: false, message: 'Не удалось скопировать ответ.' })
  })
})

describe('registerIpc: settings save reacts only to real changes', () => {
  it('does not restart voice when nothing of it moved', async () => {
    const deps = fakeDeps()
    electron.reset()
    registerIpc(deps)

    const save = electron.handles.get(CH.settings.save)!
    await save({}, {})
    expect(deps.voice.applySettings).not.toHaveBeenCalled()
  })

  it('silences the listeners while a hotkey is being recorded', async () => {
    const deps = fakeDeps()
    electron.reset()
    registerIpc(deps)

    const recording = electron.ons.get(CH.settings.recording)!
    recording({}, true)
    expect(deps.setRecording).toHaveBeenLastCalledWith(true)

    recording({}, false)
    expect(deps.setRecording).toHaveBeenLastCalledWith(false)
  })
})

describe('registerIpc: onboarding completion', () => {
  it('marks onboarding done and closes the window', async () => {
    const deps = fakeDeps()
    electron.reset()
    registerIpc(deps)

    const complete = electron.handles.get(CH.onboarding.complete)!
    await complete()
    expect(deps.quit).not.toHaveBeenCalled()
  })
})
