/**
 * The rules that decide whether the settings window may write.
 *
 * A disagreement here does not throw. It either rewrites a field under the user's
 * hands while they are typing in it, or it writes the same value on a 450 ms timer
 * forever — so the cases below are the ones where the two halves of the rule (hold
 * the write / fix the value up) have to agree.
 */

import { describe, expect, it } from 'vitest'
import type { AppSettings, ProviderId } from '@shared/types'
import { DEFAULT_SETTINGS, PROVIDERS } from '@shared/defaults'
import {
  HOLD_REASON,
  MAX_TOKENS_MAX,
  MAX_TOKENS_MIN,
  hasUnsaved,
  holdReasonFor,
  invalidBaseUrlProviders,
  tokensInRange,
  writableSettings
} from './applyGate'

/** Settings as the window usually has them: valid everywhere. */
function settings(overrides: Partial<AppSettings> = {}): AppSettings {
  const baseUrls = {} as Record<ProviderId, string>
  for (const provider of PROVIDERS) baseUrls[provider.id] = ''

  return {
    provider: 'openai',
    model: 'gpt-4o-mini',
    maxTokens: 2048,
    temperature: 0.3,
    systemPrompt: 'Ты помощник.',
    hotkey: 'Alt+Space',
    baseUrls,
    ...overrides
  } as AppSettings
}

describe('applyGate: the token bounds appear once', () => {
  it('is 64 to 8192, inclusive', () => {
    expect(MAX_TOKENS_MIN).toBe(64)
    expect(MAX_TOKENS_MAX).toBe(8192)
  })

  it('accepts both ends and rejects what is outside them', () => {
    expect(tokensInRange(MAX_TOKENS_MIN)).toBe(true)
    expect(tokensInRange(MAX_TOKENS_MAX)).toBe(true)
    expect(tokensInRange(MAX_TOKENS_MIN - 1)).toBe(false)
    expect(tokensInRange(MAX_TOKENS_MAX + 1)).toBe(false)
  })

  it('rejects a field that is not a number at all', () => {
    // A cleared number input reads as NaN before it reads as 0, and neither may
    // reach the store.
    expect(tokensInRange(Number.NaN)).toBe(false)
    expect(tokensInRange(Number.POSITIVE_INFINITY)).toBe(false)
  })

  it('names the bounds in the message the card shows', () => {
    expect(HOLD_REASON.maxTokens).toBe('Максимум токенов: от 64 до 8192.')
  })
})

describe('applyGate: an address that is not an address', () => {
  it('is not invalid when the field is empty', () => {
    // Empty means "use the official host", which is the default state.
    expect(invalidBaseUrlProviders(settings())).toEqual([])
  })

  it('is not invalid when it is a URL', () => {
    const draft = settings({ baseUrls: { ...settings().baseUrls, openai: 'https://proxy.example/v1' } })

    expect(invalidBaseUrlProviders(draft)).toEqual([])
  })

  it('is invalid when it is not one', () => {
    const draft = settings({ baseUrls: { ...settings().baseUrls, openai: 'не адрес' } })

    expect(invalidBaseUrlProviders(draft)).toEqual(['openai'])
  })

  it('is checked for every provider, not only the selected one', () => {
    const draft = settings({
      baseUrls: { ...settings().baseUrls, openai: 'мусор', anthropic: 'тоже мусор' }
    })

    expect(invalidBaseUrlProviders(draft).length).toBeGreaterThan(1)
  })
})

describe('applyGate: why a write is held', () => {
  it('is not held on valid settings', () => {
    expect(holdReasonFor(settings(), [])).toBeNull()
  })

  it('holds on an invalid base URL first', () => {
    const draft = settings({ maxTokens: 1, systemPrompt: '' })

    expect(holdReasonFor(draft, ['openai'])).toBe(HOLD_REASON.baseUrl)
  })

  it('holds a half-typed synthesis address instead of clearing the field', () => {
    // The store normalises an address it cannot parse to an empty string, so
    // writing mid-word would wipe the field the user is still typing in.
    const draft = settings({ tts: { ...DEFAULT_SETTINGS.tts, baseUrl: 'speech.example/v1' } })
    expect(holdReasonFor(draft, [])).toBe(HOLD_REASON.ttsBaseUrl)

    const valid = settings({ tts: { ...DEFAULT_SETTINGS.tts, baseUrl: 'https://speech.example/v1' } })
    expect(holdReasonFor(valid, [])).toBeNull()
  })

  it('holds a token count out of range, at both ends', () => {
    expect(holdReasonFor(settings({ maxTokens: MAX_TOKENS_MIN - 1 }), [])).toBe(HOLD_REASON.maxTokens)
    expect(holdReasonFor(settings({ maxTokens: MAX_TOKENS_MAX + 1 }), [])).toBe(HOLD_REASON.maxTokens)
  })

  it('does not hold a count exactly on a bound', () => {
    expect(holdReasonFor(settings({ maxTokens: MAX_TOKENS_MIN }), [])).toBeNull()
    expect(holdReasonFor(settings({ maxTokens: MAX_TOKENS_MAX }), [])).toBeNull()
  })

  it('holds an emptied prompt rather than letting the default replace it', () => {
    expect(holdReasonFor(settings({ systemPrompt: '   ' }), [])).toBe(HOLD_REASON.prompt)
  })

  it('holds a missing hotkey', () => {
    expect(holdReasonFor(settings({ hotkey: '  ' }), [])).toBe(HOLD_REASON.hotkey)
  })
})

describe('applyGate: is there anything to write', () => {
  it('says yes before the settings have loaded', () => {
    expect(hasUnsaved(settings(), null, null)).toBe(true)
  })

  it('says no when the draft matches what is on disk', () => {
    const draft = settings()

    expect(hasUnsaved(draft, { settings: settings() }, null)).toBe(false)
  })

  it('says yes when the draft differs', () => {
    expect(hasUnsaved(settings({ maxTokens: 4096 }), { settings: settings() }, null)).toBe(true)
  })

  it('says no when the difference is the one already written', () => {
    // The store normalises a value, so the bundle never equals the draft; the
    // snapshot of what was last sent is what stops the write loop.
    const draft = settings({ maxTokens: 4096 })

    expect(hasUnsaved(draft, { settings: settings() }, JSON.stringify(draft))).toBe(false)
  })
})

describe('applyGate: the draft as it can be written', () => {
  it('reverts a token count out of range to what is on disk', () => {
    const onDisk = settings({ maxTokens: 1024 })
    const draft = settings({ maxTokens: 0 })

    expect(writableSettings(draft, { settings: onDisk }, []).maxTokens).toBe(1024)
  })

  it('reverts an invalid base URL to what is on disk', () => {
    const onDisk = settings({ baseUrls: { ...settings().baseUrls, openai: 'https://ok.example/v1' } })
    const draft = settings({ baseUrls: { ...settings().baseUrls, openai: 'мусор' } })

    const written = writableSettings(draft, { settings: onDisk }, ['openai'])

    expect(written.baseUrls.openai).toBe('https://ok.example/v1')
  })

  it('reverts an emptied prompt and hotkey to what is on disk', () => {
    const onDisk = settings({ systemPrompt: 'Старый промпт', hotkey: 'Alt+Space' })
    const draft = settings({ systemPrompt: '', hotkey: '' })

    const written = writableSettings(draft, { settings: onDisk }, [])

    expect(written.systemPrompt).toBe('Старый промпт')
    expect(written.hotkey).toBe('Alt+Space')
  })

  it('leaves valid values alone', () => {
    const draft = settings({ maxTokens: 4096, systemPrompt: 'Новый промпт' })

    const written = writableSettings(draft, { settings: settings() }, [])

    expect(written.maxTokens).toBe(4096)
    expect(written.systemPrompt).toBe('Новый промпт')
  })

  it('does not touch the draft it was given', () => {
    const draft = settings({ maxTokens: 0 })

    writableSettings(draft, { settings: settings({ maxTokens: 1024 }) }, [])

    expect(draft.maxTokens).toBe(0)
  })

  it('passes everything through before the settings have loaded', () => {
    const draft = settings({ maxTokens: 0, systemPrompt: '' })

    const written = writableSettings(draft, null, [])

    expect(written.maxTokens).toBe(0)
    expect(written.systemPrompt).toBe('')
  })
})
