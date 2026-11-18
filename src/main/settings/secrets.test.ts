import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

interface CtorOptions {
  name: string
  defaults: Record<string, unknown>
  clearInvalidConfig?: boolean
}

const fake = vi.hoisted(() => ({
  /** The file on disk cannot be parsed. */
  corrupt: false,
  getThrows: false,
  setThrows: false,
  dir: '',
  path: '',
  ctorOptions: [] as CtorOptions[],
  data: {} as Record<string, unknown>
}))

vi.mock('electron-store', () => {
  class FakeStore {
    readonly path = fake.path
    private parsed = false

    constructor(private readonly options: CtorOptions) {
      fake.ctorOptions.push(options)
      for (const [key, value] of Object.entries(options.defaults)) {
        if (!(key in fake.data)) fake.data[key] = value
      }
    }

    get(key: string): unknown {
      this.parse()
      if (fake.getThrows) throw new Error('unreadable')
      return fake.data[key]
    }

    set(key: string, value: unknown): void {
      this.parse()
      if (fake.setThrows) throw new Error('read-only')
      fake.data[key] = value
    }

    /**
     * `conf` reads the file on the first access in the shape this fake models,
     * and `clearInvalidConfig` is honoured there: the broken file is replaced
     * with an empty one.
     */
    private parse(): void {
      if (this.parsed) return
      this.parsed = true
      if (!fake.corrupt) return
      if (!this.options.clearInvalidConfig) throw new Error('SyntaxError: Unexpected token')
      fake.corrupt = false
      fake.data = { secrets: {} }
    }
  }

  return { default: FakeStore }
})

async function loadSecrets(): Promise<typeof import('./secrets')> {
  vi.resetModules()
  return import('./secrets')
}

beforeEach(() => {
  fake.corrupt = false
  fake.getThrows = false
  fake.setThrows = false
  fake.ctorOptions = []
  fake.data = {}
  fake.dir = mkdtempSync(join(tmpdir(), 'deskhand-secrets-'))
  fake.path = join(fake.dir, 'deskhand-secrets.json')
})

afterEach(() => {
  rmSync(fake.dir, { recursive: true, force: true })
})

describe('secrets: getApiKey', () => {
  it('returns null when no key is stored', async () => {
    const secrets = await loadSecrets()
    expect(secrets.getApiKey('openai')).toBeNull()
  })

  it('returns the stored key as it was saved', async () => {
    fake.data.secrets = { openai: 'sk-live' }
    const secrets = await loadSecrets()
    expect(secrets.getApiKey('openai')).toBe('sk-live')
  })

  it('returns null for a missing or empty slot', async () => {
    fake.data.secrets = { openai: '', anthropic: 'sk-live' }
    const secrets = await loadSecrets()
    expect(secrets.getApiKey('openai')).toBeNull()
    expect(secrets.getApiKey('anthropic')).toBe('sk-live')
  })

  it('trims a hand-edited key and ignores a whitespace-only slot', async () => {
    fake.data.secrets = { openai: '  sk-padded \n', anthropic: '   ' }
    const secrets = await loadSecrets()

    expect(secrets.getApiKey('openai')).toBe('sk-padded')
    expect(secrets.hasApiKey('anthropic')).toBe(false)
  })

  it('treats a slot that is not a string as no key', async () => {
    fake.data.secrets = { openai: 42, openrouter: { key: 'x' }, anthropic: null }
    const secrets = await loadSecrets()

    expect(secrets.getApiKey('openai')).toBeNull()
    expect(secrets.getApiKey('openrouter')).toBeNull()
    expect(secrets.getApiKey('anthropic')).toBeNull()
  })
})

describe('secrets: a corrupt or unreadable file', () => {
  it('recreates a file that cannot be parsed instead of rejecting', async () => {
    fake.corrupt = true
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const secrets = await loadSecrets()

    expect(() => secrets.keyStatuses()).not.toThrow()
    expect(secrets.keyStatuses().every((status) => !status.configured)).toBe(true)
    expect(fake.ctorOptions[0].clearInvalidConfig).toBeUndefined()
    expect(fake.ctorOptions[1].clearInvalidConfig).toBe(true)
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('keeps saving keys after the file was recreated', async () => {
    fake.corrupt = true
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const secrets = await loadSecrets()

    secrets.setApiKey('openai', 'sk-new')

    expect(secrets.getApiKey('openai')).toBe('sk-new')
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('reads an unreadable file as "no keys"', async () => {
    fake.getThrows = true
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const secrets = await loadSecrets()

    expect(secrets.keyStatuses().every((status) => !status.configured)).toBe(true)
    expect(secrets.getApiKey('openai')).toBeNull()
    expect(warn).toHaveBeenCalled()
    expect(error).toHaveBeenCalled()
    warn.mockRestore()
    error.mockRestore()
  })

  it('drops a write it cannot save instead of throwing at the settings window', async () => {
    fake.setThrows = true
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const secrets = await loadSecrets()

    expect(() => secrets.setApiKey('openai', 'sk-lost')).not.toThrow()
    expect(() => secrets.deleteApiKey('openai')).not.toThrow()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})

describe('secrets: setApiKey', () => {
  it('stores the trimmed key outside the settings object', async () => {
    const secrets = await loadSecrets()
    secrets.setApiKey('openai', '  sk-123  ')

    expect(fake.data.secrets).toEqual({ openai: 'sk-123' })
    expect(secrets.getApiKey('openai')).toBe('sk-123')
  })

  it('keeps the other providers', async () => {
    fake.data.secrets = { anthropic: 'sk-anthropic' }
    const secrets = await loadSecrets()
    secrets.setApiKey('openai', 'sk-1')
    expect(Object.keys(fake.data.secrets as Record<string, string>).sort()).toEqual(['anthropic', 'openai'])
  })

  it('deletes the key when the new value is blank', async () => {
    fake.data.secrets = { openai: 'sk-old' }
    const secrets = await loadSecrets()
    secrets.setApiKey('openai', '   ')
    expect(fake.data.secrets).toEqual({})
  })
})

describe('secrets: file permissions', () => {
  it('makes an existing file private on the first open', async () => {
    writeFileSync(fake.path, '{}')
    chmodSync(fake.path, 0o666)
    const secrets = await loadSecrets()
    secrets.keyStatuses()

    expect(statSync(fake.path).mode & 0o777).toBe(0o600)
  })

  it('makes the file private again after every write', async () => {
    writeFileSync(fake.path, '{}')
    const secrets = await loadSecrets()
    secrets.keyStatuses()
    // The atomic write behind `set` takes the process umask for a new file.
    chmodSync(fake.path, 0o666)
    secrets.setApiKey('openai', 'sk-123')

    expect(statSync(fake.path).mode & 0o777).toBe(0o600)
  })
})

describe('secrets: stale storage formats', () => {
  it('drops encrypted and encoded slots from the unreleased builds', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    fake.data.secrets = { openai: 'enc:v10ciphertext', tts: 'plain:c2stdA==', anthropic: 'sk-live' }
    const secrets = await loadSecrets()

    expect(secrets.keyStatuses()).toEqual([
      { provider: 'openai', configured: false },
      { provider: 'openrouter', configured: false },
      { provider: 'anthropic', configured: true }
    ])
    expect(secrets.getApiKey('openai')).toBeNull()
    expect(secrets.hasTtsKey()).toBe(false)
    expect(fake.data.secrets).toEqual({ anthropic: 'sk-live' })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('previous storage format'))
    warn.mockRestore()
  })
})

describe('secrets: deleteApiKey', () => {
  it('removes only the given provider', async () => {
    fake.data.secrets = { openai: 'sk-openai', anthropic: 'sk-anthropic' }
    const secrets = await loadSecrets()
    secrets.deleteApiKey('openai')
    expect(fake.data.secrets).toEqual({ anthropic: 'sk-anthropic' })
  })

  it('is a no-op for a provider without a key', async () => {
    fake.data.secrets = { openai: 'sk-openai' }
    const secrets = await loadSecrets()
    secrets.deleteApiKey('anthropic')
    expect(fake.data.secrets).toEqual({ openai: 'sk-openai' })
  })
})

describe('secrets: hasApiKey', () => {
  it('reports a stored key without reading it', async () => {
    fake.data.secrets = { openai: 'sk-live' }
    const secrets = await loadSecrets()

    expect(secrets.hasApiKey('openai')).toBe(true)
  })

  it('is false for a missing, empty or non-string slot', async () => {
    fake.data.secrets = { openai: 42, openrouter: '', anthropic: null }
    const secrets = await loadSecrets()

    expect(secrets.hasApiKey('openai')).toBe(false)
    expect(secrets.hasApiKey('openrouter')).toBe(false)
    expect(secrets.hasApiKey('anthropic')).toBe(false)
  })
})

describe('secrets: hasTtsKey', () => {
  it('reports the speech key without reading it', async () => {
    fake.data.secrets = { tts: 'sk-tts' }
    const secrets = await loadSecrets()

    expect(secrets.hasTtsKey()).toBe(true)
  })

  it('is false when the speech key was never saved', async () => {
    const secrets = await loadSecrets()
    expect(secrets.hasTtsKey()).toBe(false)
  })
})

describe('secrets: keyStatuses', () => {
  it('reports every provider with its configured flag', async () => {
    fake.data.secrets = { openai: 'sk-live' }
    const secrets = await loadSecrets()
    expect(secrets.keyStatuses()).toEqual([
      { provider: 'openai', configured: true },
      { provider: 'openrouter', configured: false },
      { provider: 'anthropic', configured: false }
    ])
  })

  it('does not report a non-string slot as configured', async () => {
    fake.data.secrets = { openai: 42 }
    const secrets = await loadSecrets()

    expect(secrets.keyStatuses().map((status) => status.configured)).toEqual([false, false, false])
  })
})
