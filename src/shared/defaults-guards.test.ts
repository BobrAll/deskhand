import { describe, expect, it } from 'vitest'

import {
  DEFAULT_SETTINGS,
  PROVIDERS,
  WHISPER_MODELS,
  modelSupportsVision,
  normalizeBaseUrl,
  providerInfo,
  resolveBaseUrl,
  whisperModel
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

  it('declares vision support for all three providers today', () => {
    expect(PROVIDERS.filter((provider) => provider.supportsVision).map((provider) => provider.id)).toEqual([
      'openrouter',
      'openai',
      'anthropic'
    ])
  })

  it('is the source the default provider comes from', () => {
    expect(providerInfo(DEFAULT_SETTINGS.provider)).toBeDefined()
  })
})

describe('whisperModel: the lookup that guards a model id', () => {
  it('finds every catalog model by id', () => {
    for (const model of WHISPER_MODELS) {
      expect(whisperModel(model.id)).toBe(model)
    }
  })

  it('returns undefined for an unknown id', () => {
    expect(whisperModel('')).toBeUndefined()
    expect(whisperModel('large-v4')).toBeUndefined()
    expect(whisperModel('Small')).toBeUndefined()
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

describe('modelSupportsVision: the warning before an image is sent', () => {
  it('reports what the catalog says for a fixed provider', () => {
    expect(modelSupportsVision('openai', 'gpt-4o-mini')).toBe(true)
    expect(modelSupportsVision('anthropic', '')).toBe(true)
  })

  it('returns false for an unknown provider', () => {
    expect(modelSupportsVision('gemini' as never, 'gemini-2.5-flash')).toBe(false)
  })

  it('rejects the known text-only OpenRouter models', () => {
    for (const model of [
      'openai/o1-mini',
      'openai/o3-mini',
      'deepseek/deepseek-chat',
      'mistralai/mistral-7b-instruct',
      'meta-llama/llama-3.1-8b-instruct'
    ]) {
      expect(modelSupportsVision('openrouter', model), model).toBe(false)
    }
  })

  it('accepts any other OpenRouter model', () => {
    expect(modelSupportsVision('openrouter', 'openai/gpt-4o-mini')).toBe(true)
    expect(modelSupportsVision('openrouter', 'google/gemini-2.5-flash')).toBe(true)
    expect(modelSupportsVision('openrouter', '')).toBe(true)
  })

  it('matches the text-only list case-insensitively', () => {
    expect(modelSupportsVision('openrouter', 'DeepSeek/DeepSeek-V3')).toBe(false)
  })
})
