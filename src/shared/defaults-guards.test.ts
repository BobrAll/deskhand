import { describe, expect, it } from 'vitest'

import {
  DEFAULT_SETTINGS,
  PROVIDERS,
  WHISPER_MODELS,
  normalizeBaseUrl,
  normalizeSettings,
  providerInfo,
  resolveSearchModel,
  resolveBaseUrl,
  voiceModel
} from './defaults'

describe('providerInfo: the lookup that guards a provider id', () => {
  it('finds every provider that is in the catalog', () => {
    for (const provider of PROVIDERS) {
      expect(providerInfo(provider.id)).toBe(provider)
    }
  })

  it('returns undefined for anything that is not a provider', () => {
    expect(providerInfo('')).toBeUndefined()
    expect(providerInfo('gemini')).toBeUndefined()
    expect(providerInfo('OpenAI')).toBeUndefined()
    expect(providerInfo('__proto__')).toBeUndefined()
    expect(providerInfo('toString')).toBeUndefined()
  })
})

describe('PROVIDERS: the catalog itself', () => {
  it('has unique ids', () => {
    const ids = PROVIDERS.map((provider) => provider.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('gives every provider an https base URL with no trailing slash', () => {
    for (const provider of PROVIDERS) {
      expect(provider.defaultBaseUrl, provider.id).toMatch(/^https:\/\/[^\s/]+/)
      expect(provider.defaultBaseUrl.endsWith('/'), provider.id).toBe(false)
    }
  })

  it('gives every provider a label and a key URL', () => {
    for (const provider of PROVIDERS) {
      expect(provider.label, provider.id).toBeTruthy()
      expect(provider.keyUrl, provider.id).toMatch(/^https:\/\//)
    }
  })

  it('names no model of its own: the id is the user’s to choose', () => {
    for (const id of Object.keys(DEFAULT_SETTINGS.models) as Array<keyof typeof DEFAULT_SETTINGS.models>) {
      expect(DEFAULT_SETTINGS.models[id], id).toBe('')
    }
  })

  it('is the source the default provider comes from', () => {
    expect(providerInfo(DEFAULT_SETTINGS.provider)).toBeDefined()
  })
})

describe('voiceModel: the lookup that guards a model id', () => {
  it('finds every whisper catalog model by id', () => {
    // The whisper entries are wrapped into `VOICE_MODELS` with an engine and a
    // download URL, so the identity check is on what the wrapper copies over.
    for (const model of WHISPER_MODELS) {
      const resolved = voiceModel(model.id)
      expect(resolved?.file, model.id).toBe(model.file)
      expect(resolved?.engine, model.id).toBe('whisper')
    }
  })

  it('returns undefined for an unknown id', () => {
    expect(voiceModel('')).toBeUndefined()
    expect(voiceModel('large-v4')).toBeUndefined()
    expect(voiceModel('Small')).toBeUndefined()
  })

  it('has unique ids and unique file names ending in .bin', () => {
    const ids = WHISPER_MODELS.map((model) => model.id)
    const files = WHISPER_MODELS.map((model) => model.file)
    expect(new Set(ids).size).toBe(ids.length)
    expect(new Set(files).size).toBe(files.length)
    for (const model of WHISPER_MODELS) {
      expect(model.file, model.id).toMatch(/^ggml-.+\.bin$/)
      expect(model.mb, model.id).toBeGreaterThan(0)
      expect(model.label, model.id).toBeTruthy()
    }
  })

  it('is ordered from the smallest to the largest download', () => {
    const sizes = WHISPER_MODELS.map((model) => model.mb)
    expect([...sizes].sort((a, b) => a - b)).toEqual(sizes)
  })
})

describe('normalizeBaseUrl: a user-supplied base URL', () => {
  it('keeps a clean http(s) URL as it is', () => {
    expect(normalizeBaseUrl('https://api.openai.com/v1')).toBe('https://api.openai.com/v1')
    expect(normalizeBaseUrl('http://localhost:8080/v1')).toBe('http://localhost:8080/v1')
  })

  it('trims whitespace', () => {
    expect(normalizeBaseUrl('  https://a.example/v1  ')).toBe('https://a.example/v1')
  })

  it('drops trailing slashes, so `/v1` and `/v1/` agree', () => {
    expect(normalizeBaseUrl('https://a.example/v1/')).toBe('https://a.example/v1')
    expect(normalizeBaseUrl('https://a.example/v1///')).toBe('https://a.example/v1')
  })

  it('drops a copy-pasted endpoint path, leaving the API root', () => {
    expect(normalizeBaseUrl('https://a.example/v1/chat/completions')).toBe('https://a.example/v1')
    expect(normalizeBaseUrl('https://a.example/v1/messages')).toBe('https://a.example/v1')
    expect(normalizeBaseUrl('https://a.example/v1/models')).toBe('https://a.example/v1')
    expect(normalizeBaseUrl('https://a.example/v1/models/?tenant=deskhand#docs')).toBe(
      'https://a.example/v1?tenant=deskhand#docs'
    )
    expect(normalizeBaseUrl('https://a.example/v1/key')).toBe('https://a.example/v1')
    expect(normalizeBaseUrl('https://a.example/v1/CHAT/COMPLETIONS')).toBe('https://a.example/v1')
  })

  it('leaves a path that is not an endpoint alone', () => {
    expect(normalizeBaseUrl('https://a.example/proxy/v1')).toBe('https://a.example/proxy/v1')
    expect(normalizeBaseUrl('https://a.example/v1/keys')).toBe('https://a.example/v1/keys')
  })

  it('returns an empty string for anything that is not a usable URL', () => {
    for (const input of [
      undefined,
      null,
      42,
      {},
      [],
      '',
      '   ',
      'not a url',
      'ftp://a.example/v1',
      'javascript:alert(1)',
      'file:///etc/passwd',
      'https://',
      'https:///v1',
      '//a.example/v1'
    ]) {
      expect(normalizeBaseUrl(input), String(input)).toBe('')
    }
  })
})

describe('resolveBaseUrl: override or provider default', () => {
  it('prefers a valid override', () => {
    expect(resolveBaseUrl('openai', 'https://proxy.example/v1')).toBe('https://proxy.example/v1')
    expect(resolveBaseUrl('openai', 'https://proxy.example/v1/')).toBe('https://proxy.example/v1')
  })

  it('falls back to the provider default when the override is empty or invalid', () => {
    expect(resolveBaseUrl('openai', undefined)).toBe('https://api.openai.com/v1')
    expect(resolveBaseUrl('openai', '')).toBe('https://api.openai.com/v1')
    expect(resolveBaseUrl('openai', '  ')).toBe('https://api.openai.com/v1')
    expect(resolveBaseUrl('openai', 'nonsense')).toBe('https://api.openai.com/v1')
  })

  it('returns the provider default for every catalog provider', () => {
    for (const provider of PROVIDERS) {
      expect(resolveBaseUrl(provider.id, undefined), provider.id).toBe(provider.defaultBaseUrl)
    }
  })
})

describe('resolveSearchModel: the search model falls back to the chat model', () => {
  const settings = {
    ...DEFAULT_SETTINGS,
    models: { openrouter: '', openai: 'user-model', anthropic: '' },
    searchModels: { openrouter: '', openai: '', anthropic: '' }
  }

  it('uses the search override when the user set one', () => {
    expect(
      resolveSearchModel({
        ...settings,
        searchModels: { ...settings.searchModels, openai: 'search-model' }
      })
    ).toBe('search-model')
  })

  it('falls back to the chat model the user chose, not to a built-in name', () => {
    expect(resolveSearchModel({ ...settings, provider: 'openai' })).toBe('user-model')
  })

  it('is empty when the user has chosen nothing at all', () => {
    expect(resolveSearchModel({ ...settings, provider: 'anthropic' })).toBe('')
  })
})

describe('sanitizeVoiceModel: a choice that exists', () => {
  it('defaults to GigaAM in fresh settings and upgrades old empty selections', () => {
    expect(normalizeSettings({}).voice.model).toBe('gigaam-v3-e2e-rnnt')
    expect(normalizeSettings({ voice: { model: '' } }).voice.model).toBe('gigaam-v3-e2e-rnnt')
  })

  it('keeps an imported model outside the catalog', () => {
    expect(normalizeSettings({ voice: { model: 'ggml-custom.bin' } }).voice.model).toBe('ggml-custom.bin')
  })

  it('rejects a name that is neither a catalog id nor a model file', () => {
    expect(normalizeSettings({ voice: { model: 'large-v4' } }).voice.model).toBe('gigaam-v3-e2e-rnnt')
  })
})
