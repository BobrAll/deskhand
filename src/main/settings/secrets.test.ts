import { beforeEach, describe, expect, it, vi } from 'vitest'

interface CtorOptions {
  name: string
  defaults: Record<string, unknown>
  clearInvalidConfig?: boolean
}

const fake = vi.hoisted(() => ({
  ready: true,
  encryptionAvailable: true,
  encryptionCheckThrows: false,
  decryptThrows: false,
  /** The file on disk cannot be parsed. */
  corrupt: false,
  getThrows: false,
  setThrows: false,
  ctorOptions: [] as CtorOptions[],
  data: {} as Record<string, unknown>
}))

vi.mock('electron', () => ({
  app: { isReady: () => fake.ready },
  safeStorage: {
    isEncryptionAvailable: () => {
      if (fake.encryptionCheckThrows) throw new Error('no keychain')
      return fake.encryptionAvailable
    },
    encryptString: (plain: string) => Buffer.from(`enc(${plain})`, 'utf8'),
    decryptString: (buffer: Buffer) => {
      if (fake.decryptThrows) throw new Error('locked')
      const value = buffer.toString('utf8')
      if (!value.startsWith('enc(') || !value.endsWith(')')) throw new Error('bad ciphertext')
      return value.slice(4, -1)
    }
  }
}))

vi.mock('electron-store', () => {
  class FakeStore {
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

const b64 = (value: string): string => Buffer.from(value, 'utf8').toString('base64')

beforeEach(() => {
  fake.ready = true
  fake.encryptionAvailable = true
  fake.encryptionCheckThrows = false
  fake.decryptThrows = false
  fake.corrupt = false
  fake.getThrows = false
  fake.setThrows = false
  fake.ctorOptions = []
  fake.data = {}
})

describe('secrets: encryptionAvailable', () => {
  it('is false before the app is ready', async () => {
    fake.ready = false
    const secrets = await loadSecrets()
    expect(secrets.encryptionAvailable()).toBe(false)
  })

  it('is false when the Keychain check throws', async () => {
    fake.encryptionCheckThrows = true
    const secrets = await loadSecrets()
    expect(secrets.encryptionAvailable()).toBe(false)
  })

  it('follows safeStorage once the app is ready', async () => {
    const secrets = await loadSecrets()
    expect(secrets.encryptionAvailable()).toBe(true)
    fake.encryptionAvailable = false
    expect(secrets.encryptionAvailable()).toBe(false)
  })
})

describe('secrets: getApiKey', () => {
  it('returns null when no key is stored', async () => {
    const secrets = await loadSecrets()
    expect(secrets.getApiKey('openai')).toBeNull()
  })

  it('decodes a plain: value without touching safeStorage', async () => {
    // decryptString throws here, so a value that still decodes proves the path.
    fake.decryptThrows = true
    fake.data.secrets = { openai: `plain:${b64('sk-plain')}` }
    const secrets = await loadSecrets()
    expect(secrets.getApiKey('openai')).toBe('sk-plain')
  })

  it('decrypts an enc: value', async () => {
    fake.data.secrets = { anthropic: `enc:${b64('enc(sk-enc)')}` }
    const secrets = await loadSecrets()
    expect(secrets.getApiKey('anthropic')).toBe('sk-enc')
  })

  it('returns null for a locked Keychain, and says so in the log', async () => {
    // The slot is still on disk, so the card will ask for the key again. That is
    // the right behaviour, but without the warning the only trace of a Keychain
    // reset was a user wondering why the key they entered is being asked for.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    fake.decryptThrows = true
    fake.data.secrets = { openai: `enc:${b64('enc(sk)')}` }
    const secrets = await loadSecrets()
    expect(secrets.getApiKey('openai')).toBeNull()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('cannot be decrypted'), expect.anything())
    warn.mockRestore()
  })

  it('returns null when the payload is empty', async () => {
    fake.data.secrets = { openai: 'plain:', anthropic: 'enc:' }
    const secrets = await loadSecrets()
    expect(secrets.getApiKey('openai')).toBeNull()
    expect(secrets.getApiKey('anthropic')).toBeNull()
  })

  it('returns null for a value without a payload', async () => {
    fake.data.secrets = { openai: 'enc', openrouter: '', anthropic: 'plain' }
    const secrets = await loadSecrets()
    expect(secrets.getApiKey('openai')).toBeNull()
    expect(secrets.getApiKey('openrouter')).toBeNull()
    expect(secrets.getApiKey('anthropic')).toBeNull()
  })

  it('returns null for an unknown scheme it cannot decrypt', async () => {
    fake.data.secrets = { openai: `weird:${b64('sk')}` }
    const secrets = await loadSecrets()
    expect(secrets.getApiKey('openai')).toBeNull()
  })

  it('treats a slot that is not a string as no key', async () => {
    fake.data.secrets = { openai: 42, openrouter: { enc: 'x' }, anthropic: null }
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
  it('stores an enc: value when encryption is available', async () => {
    const secrets = await loadSecrets()
    secrets.setApiKey('openai', '  sk-123  ')
    const stored = (fake.data.secrets as Record<string, string>).openai
    expect(stored.startsWith('enc:')).toBe(true)
    expect(secrets.getApiKey('openai')).toBe('sk-123')
  })

  it('stores a plain: value when encryption is unavailable', async () => {
    fake.ready = false
    const secrets = await loadSecrets()
    secrets.setApiKey('openai', 'sk-123')
    expect(fake.data.secrets).toEqual({ openai: `plain:${b64('sk-123')}` })
  })

  it('keeps the other providers', async () => {
    fake.data.secrets = { anthropic: `plain:${b64('a')}` }
    const secrets = await loadSecrets()
    secrets.setApiKey('openai', 'sk-1')
    expect(Object.keys(fake.data.secrets as Record<string, string>).sort()).toEqual(['anthropic', 'openai'])
  })

  it('deletes the key when the new value is blank', async () => {
    fake.data.secrets = { openai: `plain:${b64('a')}` }
    const secrets = await loadSecrets()
    secrets.setApiKey('openai', '   ')
    expect(fake.data.secrets).toEqual({})
  })
})

describe('secrets: deleteApiKey', () => {
  it('removes only the given provider', async () => {
    fake.data.secrets = { openai: `plain:${b64('a')}`, anthropic: `plain:${b64('b')}` }
    const secrets = await loadSecrets()
    secrets.deleteApiKey('openai')
    expect(fake.data.secrets).toEqual({ anthropic: `plain:${b64('b')}` })
  })

  it('is a no-op for a provider without a key', async () => {
    fake.data.secrets = { openai: `plain:${b64('a')}` }
    const secrets = await loadSecrets()
    secrets.deleteApiKey('anthropic')
    expect(fake.data.secrets).toEqual({ openai: `plain:${b64('a')}` })
  })
})

describe('secrets: keyStatuses', () => {
  it('reports every provider with its configured flag', async () => {
    fake.data.secrets = { openai: `plain:${b64('a')}` }
    const secrets = await loadSecrets()
    expect(secrets.keyStatuses()).toEqual([
      { provider: 'openai', configured: true, encryptionAvailable: true },
      { provider: 'openrouter', configured: false, encryptionAvailable: true },
      { provider: 'anthropic', configured: false, encryptionAvailable: true }
    ])
  })

  it('does not report a non-string slot as configured', async () => {
    fake.data.secrets = { openai: 42 }
    const secrets = await loadSecrets()

    expect(secrets.keyStatuses()[0]).toMatchObject({ provider: 'openai', configured: false })
  })

  it('reports encryption as unavailable when the Keychain is locked', async () => {
    fake.ready = false
    const secrets = await loadSecrets()
    expect(secrets.keyStatuses().every((status) => !status.encryptionAvailable)).toBe(true)
  })
})
