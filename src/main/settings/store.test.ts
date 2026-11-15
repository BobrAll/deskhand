import { beforeEach, describe, expect, it, vi } from 'vitest'

import { DEFAULT_SETTINGS } from '@shared/defaults'

interface CtorOptions {
  name: string
  defaults: Record<string, unknown>
  clearInvalidConfig?: boolean
}

const fake = vi.hoisted(() => ({
  /** The file on disk cannot be parsed. */
  corrupt: false,
  /** Every constructor call throws: the profile directory itself is unusable. */
  ctorThrows: false,
  ctorOptions: [] as CtorOptions[],
  data: {} as Record<string, unknown>,
  getThrows: false,
  setThrows: false
}))

vi.mock('electron-store', () => {
  class FakeStore {
    private parsed = false

    constructor(private readonly options: CtorOptions) {
      fake.ctorOptions.push(options)
      // `conf` reads the file either in the constructor or on the first access,
      // and only the read honours `clearInvalidConfig`. Parsing in `get` here is
      // what exercises the recovery path: a throwing constructor alone would
      // leave the read path — and the second store — untested.
      if (fake.ctorThrows) throw new Error('profile is read-only')
    }

    get(key: string): unknown {
      this.parse()
      if (fake.getThrows) throw new Error('unreadable')
      return key in fake.data ? fake.data[key] : this.options.defaults[key]
    }

    set(key: string, value: unknown): void {
      this.parse()
      if (fake.setThrows) throw new Error('read-only')
      fake.data[key] = value
    }

    /**
     * In this fake `conf` reads the file on the first access, which is where
     * `clearInvalidConfig` applies: the broken file is replaced with an empty
     * one. This is the path a successful constructor would hide.
     */
    private parse(): void {
      if (this.parsed) return
      this.parsed = true
      if (!fake.corrupt) return
      if (!this.options.clearInvalidConfig) throw new Error('SyntaxError: Unexpected token')
      fake.corrupt = false
      fake.data = {}
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
  fake.corrupt = false
  fake.ctorThrows = false
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

  it('keeps the plain store when the file parses, without asking for a reset', async () => {
    fake.data.settings = { temperature: 1.1 }
    const store = await loadStore()
    store.getSettings()

    expect(fake.ctorOptions).toHaveLength(1)
    expect(fake.ctorOptions[0].clearInvalidConfig).toBeUndefined()
  })
})

describe('settings/store: a corrupt file is recreated', () => {
  it('retries with clearInvalidConfig and flags the recovery', async () => {
    // The parse happens on the first read here, where `clearInvalidConfig`
    // applies; the constructor succeeds and used to hide the recovery path.
    fake.corrupt = true
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const store = await loadStore()

    expect(store.getSettings()).toEqual(DEFAULT_SETTINGS)
    expect(fake.ctorOptions).toHaveLength(2)
    expect(fake.ctorOptions[0].clearInvalidConfig).toBeUndefined()
    expect(fake.ctorOptions[1].clearInvalidConfig).toBe(true)
    expect(store.settingsWereRecovered()).toBe(true)
    warn.mockRestore()
  })

  it('warns once rather than throwing', async () => {
    fake.corrupt = true
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const store = await loadStore()

    expect(() => store.getSettings()).not.toThrow()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('keeps saving after the file was recreated', async () => {
    fake.corrupt = true
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const store = await loadStore()

    const saved = store.patchSettings({ temperature: 1.4 })

    expect(saved.temperature).toBe(1.4)
    expect(fake.data.settings).toMatchObject({ temperature: 1.4 })
    expect(store.settingsWriteFailed()).toBe(false)
    expect(store.getSettings().temperature).toBe(1.4)
    warn.mockRestore()
  })

  it('falls back to memory when even a reset store cannot be opened', async () => {
    fake.ctorThrows = true
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const store = await loadStore()

    expect(store.getSettings()).toEqual(DEFAULT_SETTINGS)
    expect(store.settingsWereRecovered()).toBe(true)
    expect(error).toHaveBeenCalled()
    warn.mockRestore()
    error.mockRestore()
  })

  it('keeps a patch in memory when there is no store to write to', async () => {
    fake.ctorThrows = true
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const store = await loadStore()

    const saved = store.patchSettings({ temperature: 1.5, hotkey: 'Ctrl+P' })

    expect(saved.temperature).toBe(1.5)
    // The next read comes from the in-memory copy, not from the defaults.
    expect(store.getSettings().temperature).toBe(1.5)
    expect(store.getSettings().hotkey).toBe('Ctrl+P')
    // A write that never reached a file is reported, not swallowed.
    expect(store.settingsWriteFailed()).toBe(true)
    warn.mockRestore()
    error.mockRestore()
  })
})

describe('settings/store: unreadable settings inside a working file', () => {
  it('falls back to the defaults and flags the recovery', async () => {
    fake.getThrows = true
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const store = await loadStore()

    expect(store.getSettings()).toEqual(DEFAULT_SETTINGS)
    expect(store.settingsWereRecovered()).toBe(true)
    warn.mockRestore()
    error.mockRestore()
  })
})

describe('settings/store: patchSettings', () => {
  it('merges the patch over the current settings and persists it', async () => {
    const store = await loadStore()

    const saved = store.patchSettings({ temperature: 1.2 })

    expect(saved.temperature).toBe(1.2)
    expect(saved.hotkey).toBe(DEFAULT_SETTINGS.hotkey)
    expect(fake.data.settings).toEqual(saved)
    expect(store.settingsWriteFailed()).toBe(false)
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

  it('keeps the value and reports the write that was dropped', async () => {
    const store = await loadStore()
    fake.setThrows = true
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const saved = store.patchSettings({ temperature: 0.9 })

    expect(saved.temperature).toBe(0.9)
    // The user's edit must not silently revert to the stale file.
    expect(store.getSettings().temperature).toBe(0.9)
    expect(store.settingsWriteFailed()).toBe(true)
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('clears the failure flag once a later write lands', async () => {
    const store = await loadStore()
    fake.setThrows = true
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    store.patchSettings({ temperature: 0.9 })

    fake.setThrows = false
    const saved = store.patchSettings({ temperature: 1.1 })

    expect(store.settingsWriteFailed()).toBe(false)
    expect(fake.data.settings).toEqual(saved)
    expect(store.getSettings().temperature).toBe(1.1)
    warn.mockRestore()
  })
})
