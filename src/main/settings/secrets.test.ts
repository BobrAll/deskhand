import { beforeEach, describe, expect, it, vi } from 'vitest'

const fake = vi.hoisted(() => ({
  ready: true,
  encryptionAvailable: true,
  encryptionCheckThrows: false,
  decryptThrows: false,
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
    constructor(options: { defaults: Record<string, unknown> }) {
      for (const [key, value] of Object.entries(options.defaults)) {
        if (!(key in fake.data)) fake.data[key] = value
      }
    }
    get(key: string): unknown {
      return fake.data[key]
    }
    set(key: string, value: unknown): void {
      fake.data[key] = value
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

  it('returns null for a locked Keychain', async () => {
    fake.decryptThrows = true
    fake.data.secrets = { openai: `enc:${b64('enc(sk)')}` }
    const secrets = await loadSecrets()
    expect(secrets.getApiKey('openai')).toBeNull()
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
    expect(Object.keys(fake.data.secrets as Record<string, string>).sort()).toEqual([
      'anthropic',
      'openai'
    ])
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
      { provider: 'openrouter', configured: false, encryptionAvailable: true },
      { provider: 'openai', configured: true, encryptionAvailable: true },
      { provider: 'anthropic', configured: false, encryptionAvailable: true }
    ])
  })

  it('reports encryption as unavailable when the Keychain is locked', async () => {
    fake.ready = false
    const secrets = await loadSecrets()
    expect(secrets.keyStatuses().every((status) => !status.encryptionAvailable)).toBe(true)
  })
})
