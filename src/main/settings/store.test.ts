import { beforeEach, describe, expect, it, vi } from 'vitest'

import { DEFAULT_SETTINGS } from '@shared/defaults'

interface CtorOptions {
  name: string
  defaults: Record<string, unknown>
  clearInvalidConfig?: boolean
}

const fake = vi.hoisted(() => ({
  /** How many upcoming constructor calls throw before one succeeds. */
  failCtorTimes: 0,
  /** When true every constructor call throws. */
  failCtorAlways: false,
  ctorOptions: [] as CtorOptions[],
  data: {} as Record<string, unknown>,
  getThrows: false,
  setThrows: false
}))

vi.mock('electron-store', () => {
  class FakeStore {
    constructor(options: CtorOptions) {
      fake.ctorOptions.push(options)
      if (fake.failCtorAlways) throw new Error('corrupt file')
      if (fake.failCtorTimes > 0) {
        fake.failCtorTimes -= 1
        throw new Error('corrupt file')
      }
    }

    get(key: string): unknown {
      if (fake.getThrows) throw new Error('unreadable')
      return key in fake.data ? fake.data[key] : this.defaultsFor(key)
    }

    set(key: string, value: unknown): void {
      if (fake.setThrows) throw new Error('read-only')
      fake.data[key] = value
    }

    private defaultsFor(key: string): unknown {
      const last = fake.ctorOptions[fake.ctorOptions.length - 1]
      return last?.defaults?.[key]
    }
  }

  return { default: FakeStore }
})

/** Re-imports the module so its singleton state is fresh for each test. */
async function loadStore(): Promise<typeof import('./store')> {
  vi.resetModules()
  return import('./store')
}

beforeEach(() => {
  fake.failCtorTimes = 0
  fake.failCtorAlways = false
  fake.ctorOptions = []
  fake.data = {}
  fake.getThrows = false
  fake.setThrows = false
})

describe('settings/store: opening the file', () => {
  it('returns the defaults when nothing is stored yet', async () => {
    const store = await loadStore()

    expect(store.getSettings()).toEqual(DEFAULT_SETTINGS)
    expect(store.settingsWereRecovered()).toBe(false)
  })

  it('opens the store once and reuses it', async () => {
    const store = await loadStore()
    store.getSettings()
    store.getSettings()
    store.patchSettings({ temperature: 1 })

    expect(fake.ctorOptions).toHaveLength(1)
  })

  it('reads and normalizes what is on disk', async () => {
    fake.data.settings = { temperature: 9, hotkey: '  Cmd+J  ', provider: 'nope' }
    const store = await loadStore()

    const settings = store.getSettings()

    expect(settings.temperature).toBe(2)
    expect(settings.hotkey).toBe('Cmd+J')
    expect(settings.provider).toBe(DEFAULT_SETTINGS.provider)
    expect(store.settingsWereRecovered()).toBe(false)
  })
})

describe('settings/store: a corrupt file is recreated', () => {
  it('retries with clearInvalidConfig and flags the recovery', async () => {
    fake.failCtorTimes = 1
    const store = await loadStore()

    expect(store.getSettings()).toEqual(DEFAULT_SETTINGS)
    expect(fake.ctorOptions).toHaveLength(2)
    expect(fake.ctorOptions[0].clearInvalidConfig).toBeUndefined()
    expect(fake.ctorOptions[1].clearInvalidConfig).toBe(true)
    expect(store.settingsWereRecovered()).toBe(true)
  })

  it('warns once rather than throwing', async () => {
    fake.failCtorTimes = 1
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const store = await loadStore()

    expect(() => store.getSettings()).not.toThrow()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('falls back to memory when even a reset store cannot be opened', async () => {
    fake.failCtorAlways = true
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const store = await loadStore()

    expect(store.getSettings()).toEqual(DEFAULT_SETTINGS)
    expect(store.settingsWereRecovered()).toBe(true)
    expect(error).toHaveBeenCalled()
    error.mockRestore()
  })

  it('keeps a patch in memory when there is no store to write to', async () => {
    fake.failCtorAlways = true
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const store = await loadStore()

    const saved = store.patchSettings({ temperature: 1.5, hotkey: 'Ctrl+P' })

    expect(saved.temperature).toBe(1.5)
    // The next read comes from the in-memory copy, not from the defaults.
    expect(store.getSettings().temperature).toBe(1.5)
    expect(store.getSettings().hotkey).toBe('Ctrl+P')
    error.mockRestore()
  })
})

describe('settings/store: unreadable settings inside a working file', () => {
  it('falls back to the defaults and flags the recovery', async () => {
    fake.getThrows = true
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const store = await loadStore()

    expect(store.getSettings()).toEqual(DEFAULT_SETTINGS)
    expect(store.settingsWereRecovered()).toBe(true)
    warn.mockRestore()
  })
})

describe('settings/store: patchSettings', () => {
  it('merges the patch over the current settings and persists it', async () => {
    const store = await loadStore()

    const saved = store.patchSettings({ temperature: 1.2 })

    expect(saved.temperature).toBe(1.2)
    expect(saved.hotkey).toBe(DEFAULT_SETTINGS.hotkey)
    expect(fake.data.settings).toEqual(saved)
  })

  it('normalizes the merged result', async () => {
    const store = await loadStore()

    expect(store.patchSettings({ temperature: 99 }).temperature).toBe(2)
    expect(store.patchSettings({ maxTokens: 1 }).maxTokens).toBe(64)
  })

  it('keeps the previous settings for keys the patch omits', async () => {
    fake.data.settings = { temperature: 1.7, hotkey: 'Cmd+J' }
    const store = await loadStore()

    store.patchSettings({ maxTokens: 2048 })

    expect(store.getSettings()).toMatchObject({
      temperature: 1.7,
      hotkey: 'Cmd+J',
      maxTokens: 2048
    })
  })

  // KNOWN BUG: characterization — `memoryFallback` is only consulted when the
  // store itself could not be opened, so a failed write returns the new value
  // once and then reverts to whatever the file still holds.
  it('returns the new value but does not keep it when the write fails (known bug)', async () => {
    const store = await loadStore()
    fake.setThrows = true
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const saved = store.patchSettings({ temperature: 0.9 })

    expect(saved.temperature).toBe(0.9)
    expect(store.getSettings().temperature).toBe(DEFAULT_SETTINGS.temperature)
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})
