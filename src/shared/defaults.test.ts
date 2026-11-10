import { describe, expect, it } from 'vitest'

import {
  DEFAULT_AGENT,
  DEFAULT_EXCLUDED_APPS,
  DEFAULT_SETTINGS,
  DEFAULT_SYSTEM_PROMPT,
  DEFAULT_VOICE,
  normalizeSettings,
  parseExtraBody,
  resolveSearchModel
} from './defaults'

describe('parseExtraBody', () => {
  it('treats empty text as no extra fields', () => {
    expect(parseExtraBody('')).toEqual({})
    expect(parseExtraBody('   ')).toEqual({})
    expect(parseExtraBody(undefined)).toEqual({})
  })

  it('returns the object the user typed', () => {
    expect(parseExtraBody('{"thinking": {"type": "disabled"}}')).toEqual({ thinking: { type: 'disabled' } })
  })

  it('rejects text that is not a JSON object', () => {
    for (const text of ['{oops', '[1]', '"none"', '42', 'null']) {
      expect(parseExtraBody(text), text).toBeNull()
    }
  })

  it('drops fields that would replace the conversation or the stream', () => {
    expect(parseExtraBody('{"stream": false, "messages": [], "model": "x", "top_p": 0.5}'))
      .toEqual({ top_p: 0.5 })
  })
})

// `models` is the one block that does not fall back to the shipped defaults: an
// empty bag normalizes to empty model names, and an empty name means "use the
// provider default" (see `AppSettings.models`).
const EMPTY_MODELS = { openrouter: '', openai: '', anthropic: '' }

describe('normalizeSettings: empty and malformed input', () => {
  it('returns the defaults for undefined, null and primitives', () => {
    for (const input of [undefined, null, 0, '', 'текст', true, NaN]) {
      expect(normalizeSettings(input), String(input)).toEqual({
        ...DEFAULT_SETTINGS,
        models: EMPTY_MODELS
      })
    }
  })

  it('returns the defaults for an empty object', () => {
    expect(normalizeSettings({})).toEqual({ ...DEFAULT_SETTINGS, models: EMPTY_MODELS })
  })

  it('returns the defaults for an array', () => {
    // An array is an object, so it is read as a settings-shaped bag with no keys.
    expect(normalizeSettings([])).toEqual({ ...DEFAULT_SETTINGS, models: EMPTY_MODELS })
  })

  it('does not mutate its input', () => {
    const input = { temperature: 1.2, quickActions: [{ id: 'a', label: 'A', prompt: 'P' }] }
    const snapshot = JSON.stringify(input)

    normalizeSettings(input)

    expect(JSON.stringify(input)).toBe(snapshot)
  })
})

describe('normalizeSettings: partial data', () => {
  it('keeps the given values and fills the rest from defaults', () => {
    const result = normalizeSettings({ temperature: 1.1, maxTokens: 2048, hotkey: 'Ctrl+K' })

    expect(result.temperature).toBe(1.1)
    expect(result.maxTokens).toBe(2048)
    expect(result.hotkey).toBe('Ctrl+K')
    expect(result.provider).toBe(DEFAULT_SETTINGS.provider)
    expect(result.voice).toEqual(DEFAULT_VOICE)
  })

  it('trims string fields', () => {
    const result = normalizeSettings({
      hotkey: '  Alt+Space  ',
      models: { openai: '  gpt-4o  ' }
    })

    expect(result.hotkey).toBe('Alt+Space')
    expect(result.models.openai).toBe('gpt-4o')
  })

  it('replaces a blank string with the default', () => {
    expect(normalizeSettings({ hotkey: '   ' }).hotkey).toBe(DEFAULT_SETTINGS.hotkey)
    expect(normalizeSettings({ systemPrompt: '  ' }).systemPrompt).toBe(DEFAULT_SYSTEM_PROMPT)
    expect(normalizeSettings({ models: { openai: '   ' } }).models.openai).toBe('')
  })

  it('keeps a non-blank systemPrompt verbatim, without trimming', () => {
    expect(normalizeSettings({ systemPrompt: '  свой промпт  ' }).systemPrompt).toBe(
      '  свой промпт  '
    )
  })
})

describe('normalizeSettings: extra keys are dropped', () => {
  it('returns exactly the known keys', () => {
    const result = normalizeSettings({ ...DEFAULT_SETTINGS, somethingElse: 42, __proto__: 'x' })

    expect(Object.keys(result).sort()).toEqual(Object.keys(DEFAULT_SETTINGS).sort())
    expect(result).not.toHaveProperty('somethingElse')
  })

  it('drops unknown keys inside nested objects', () => {
    const result = normalizeSettings({
      voice: { ...DEFAULT_VOICE, extra: 1 },
      agent: { ...DEFAULT_AGENT, extra: 2 }
    })

    expect(result.voice).not.toHaveProperty('extra')
    expect(result.agent).not.toHaveProperty('extra')
  })
})

describe('normalizeSettings: a retired key silently loses its value', () => {
  it('drops a key the schema no longer has', () => {
    // A2 removed the `hideOverlayOnBlur` toggle; a settings file written by an
    // older build must still load, with the key dropped and everything else intact.
    const result = normalizeSettings({ hideOverlayOnBlur: true, hotkey: 'Cmd+Shift+J' })

    expect(result).not.toHaveProperty('hideOverlayOnBlur')
    expect(result.hotkey).toBe('Cmd+Shift+J')
    expect(result.captureScreenshotByDefault).toBe(DEFAULT_SETTINGS.captureScreenshotByDefault)
  })

  it('loses a renamed key inside a nested object too', () => {
    const result = normalizeSettings({ voice: { language: 'en', modelId: 'base' } })

    expect(result.voice.language).toBe('en')
    expect(result.voice.model).toBe(DEFAULT_VOICE.model)
    expect(result.voice).not.toHaveProperty('modelId')
  })

  it('loses a renamed provider entry', () => {
    const result = normalizeSettings({ provider: 'gpt' })

    expect(result.provider).toBe(DEFAULT_SETTINGS.provider)
  })
})

describe('normalizeSettings: provider', () => {
  it('accepts every known provider', () => {
    for (const provider of ['openrouter', 'openai', 'anthropic'] as const) {
      expect(normalizeSettings({ provider }).provider).toBe(provider)
    }
  })

  it('falls back on an unknown provider', () => {
    expect(normalizeSettings({ provider: 'gemini' }).provider).toBe(DEFAULT_SETTINGS.provider)
    expect(normalizeSettings({ provider: '' }).provider).toBe(DEFAULT_SETTINGS.provider)
    expect(normalizeSettings({ provider: 42 }).provider).toBe(DEFAULT_SETTINGS.provider)
  })
})

describe('normalizeSettings: models and base URLs', () => {
  it('keeps web search model overrides separate and falls back to the chat model', () => {
    const settings = normalizeSettings({
      provider: 'openrouter',
      models: { openrouter: 'ordinary-model' },
      searchModels: { openrouter: '  search-model  ', openai: false }
    })
    expect(settings.models.openrouter).toBe('ordinary-model')
    expect(settings.searchModels).toEqual({ ...EMPTY_MODELS, openrouter: 'search-model' })
    expect(resolveSearchModel(settings)).toBe('search-model')
    expect(resolveSearchModel({ ...settings, searchModels: EMPTY_MODELS })).toBe('ordinary-model')
    // A provider with nothing chosen has nothing to fall back to: there is no
    // built-in model name to reach for.
    expect(resolveSearchModel({ ...settings, provider: 'openai' })).toBe('')
  })

  it('keeps a model per provider and defaults the rest to empty', () => {
    const result = normalizeSettings({ models: { anthropic: 'claude-3-5-sonnet' } })

    expect(result.models).toEqual({ openrouter: '', openai: '', anthropic: 'claude-3-5-sonnet' })
  })

  it('ignores a non-object models value, leaving every model empty', () => {
    expect(normalizeSettings({ models: 'gpt' }).models).toEqual(EMPTY_MODELS)
    expect(normalizeSettings({ models: null }).models).toEqual(EMPTY_MODELS)
  })

  it('normalizes base URLs, dropping trailing slashes and endpoint paths', () => {
    const result = normalizeSettings({
      baseUrls: {
        openai: 'https://api.example.com/v1/',
        openrouter: 'https://openrouter.ai/api/v1/chat/completions',
        anthropic: 'https://proxy.local/v1/messages'
      }
    })

    expect(result.baseUrls).toEqual({
      openai: 'https://api.example.com/v1',
      openrouter: 'https://openrouter.ai/api/v1',
      anthropic: 'https://proxy.local/v1'
    })
  })

  it('empties a base URL that is not a usable http(s) URL', () => {
    const result = normalizeSettings({
      baseUrls: { openai: 'ftp://example.com', openrouter: 'not a url', anthropic: '  ' }
    })

    expect(result.baseUrls).toEqual({ openai: '', openrouter: '', anthropic: '' })
  })
})

describe('normalizeSettings: numeric clamps', () => {
  it('clamps temperature to 0..2', () => {
    expect(normalizeSettings({ temperature: -1 }).temperature).toBe(0)
    expect(normalizeSettings({ temperature: 5 }).temperature).toBe(2)
    expect(normalizeSettings({ temperature: 0.7 }).temperature).toBe(0.7)
  })

  it('rounds and clamps maxTokens to 64..8192', () => {
    expect(normalizeSettings({ maxTokens: 1 }).maxTokens).toBe(64)
    expect(normalizeSettings({ maxTokens: 99999 }).maxTokens).toBe(8192)
    expect(normalizeSettings({ maxTokens: 1000.6 }).maxTokens).toBe(1001)
  })

  it('rounds and clamps screenshotMaxSide to 480..2400', () => {
    expect(normalizeSettings({ screenshotMaxSide: 100 }).screenshotMaxSide).toBe(480)
    expect(normalizeSettings({ screenshotMaxSide: 9999 }).screenshotMaxSide).toBe(2400)
    expect(normalizeSettings({ screenshotMaxSide: 1200.4 }).screenshotMaxSide).toBe(1200)
  })

  it('rounds and clamps screenshotQuality to 30..95', () => {
    expect(normalizeSettings({ screenshotQuality: 0 }).screenshotQuality).toBe(30)
    expect(normalizeSettings({ screenshotQuality: 100 }).screenshotQuality).toBe(95)
    expect(normalizeSettings({ screenshotQuality: 80.6 }).screenshotQuality).toBe(81)
  })

  it('falls back on non-numeric or non-finite numbers', () => {
    for (const value of ['1.5', NaN, Infinity, null, {}, []]) {
      expect(normalizeSettings({ temperature: value }).temperature, String(value)).toBe(
        DEFAULT_SETTINGS.temperature
      )
    }
  })
})

describe('normalizeSettings: booleans', () => {
  it('keeps booleans and falls back on anything else', () => {
    expect(normalizeSettings({ captureScreenshotByDefault: false }).captureScreenshotByDefault).toBe(
      false
    )
    expect(normalizeSettings({ captureScreenshotByDefault: true }).captureScreenshotByDefault).toBe(
      true
    )
    // A string is not a boolean: the field keeps its default rather than truthiness.
    expect(normalizeSettings({ launchAtLogin: 'true' }).launchAtLogin).toBe(false)
    expect(normalizeSettings({ launchAtLogin: 1 }).launchAtLogin).toBe(false)
    expect(normalizeSettings({ onboardingCompleted: 'yes' }).onboardingCompleted).toBe(false)
  })
})

describe('normalizeSettings: legacy settings', () => {
  it('ignores saved quick actions and keeps other preferences', () => {
    const result = normalizeSettings({
      quickActions: [{ id: 'a', label: 'A', prompt: 'P', mode: 'insert' }],
      temperature: 1.2
    })

    expect(result).not.toHaveProperty('quickActions')
    expect(result.temperature).toBe(1.2)
  })
})

describe('normalizeSettings: excludedApps', () => {
  it('keeps a clean list, trimmed and de-duplicated', () => {
    const result = normalizeSettings({
      excludedApps: [' com.a ', 'com.a', 'com.b', '', '   ', 42, null]
    })

    expect(result.excludedApps).toEqual(['com.a', 'com.b'])
  })

  it('falls back on a non-array value', () => {
    expect(normalizeSettings({ excludedApps: 'com.a' }).excludedApps).toEqual(DEFAULT_EXCLUDED_APPS)
    expect(normalizeSettings({ excludedApps: {} }).excludedApps).toEqual(DEFAULT_EXCLUDED_APPS)
  })

  it('accepts an empty array, which means "nothing is excluded"', () => {
    expect(normalizeSettings({ excludedApps: [] }).excludedApps).toEqual([])
  })
})

describe('normalizeSettings: voice', () => {
  it('fills a missing voice block from the defaults', () => {
    expect(normalizeSettings({}).voice).toEqual(DEFAULT_VOICE)
    expect(normalizeSettings({ voice: null }).voice).toEqual(DEFAULT_VOICE)
    expect(normalizeSettings({ voice: 'x' }).voice).toEqual(DEFAULT_VOICE)
  })

  it('keeps a known model and rejects an unknown one', () => {
    expect(normalizeSettings({ voice: { model: 'base' } }).voice.model).toBe('base')
    expect(normalizeSettings({ voice: { model: 'gigantic' } }).voice.model).toBe(DEFAULT_VOICE.model)
  })

  it('lowercases and truncates the language', () => {
    expect(normalizeSettings({ voice: { language: 'EN' } }).voice.language).toBe('en')
    expect(normalizeSettings({ voice: { language: 'ОченьДлинный' } }).voice.language).toBe(
      'оченьдли'
    )
    expect(normalizeSettings({ voice: { language: '   ' } }).voice.language).toBe(
      DEFAULT_VOICE.language
    )
  })

  it('treats any action other than dictate as command', () => {
    expect(normalizeSettings({ voice: { action: 'dictate' } }).voice.action).toBe('dictate')
    expect(normalizeSettings({ voice: { action: 'command' } }).voice.action).toBe('command')
    expect(normalizeSettings({ voice: { action: 'что-то' } }).voice.action).toBe('command')
  })

  it('clamps the duration window', () => {
    expect(normalizeSettings({ voice: { minDurationMs: -100 } }).voice.minDurationMs).toBe(0)
    expect(normalizeSettings({ voice: { minDurationMs: 99999 } }).voice.minDurationMs).toBe(5000)
    expect(normalizeSettings({ voice: { maxDurationMs: 10 } }).voice.maxDurationMs).toBe(1000)
    expect(normalizeSettings({ voice: { maxDurationMs: 9999999 } }).voice.maxDurationMs).toBe(
      600_000
    )
  })

  it('keeps the boolean flags', () => {
    const result = normalizeSettings({ voice: { enabled: false, autoSend: false } })

    expect(result.voice.enabled).toBe(false)
    expect(result.voice.autoSend).toBe(false)
    expect(normalizeSettings({ voice: { enabled: 'no' } }).voice.enabled).toBe(true)
  })

  it('falls back on a blank hotkey', () => {
    expect(normalizeSettings({ voice: { hotkey: '  ' } }).voice.hotkey).toBe(DEFAULT_VOICE.hotkey)
    expect(normalizeSettings({ voice: { hotkey: ' Ctrl+1 ' } }).voice.hotkey).toBe('Ctrl+1')
  })
})

describe('normalizeSettings: agent', () => {
  it('keeps the step budget the user typed, with a floor of one', () => {
    const result = normalizeSettings({ agent: { maxSteps: 0 } })

    expect(result.agent.maxSteps).toBe(1)
    expect(normalizeSettings({ agent: { maxSteps: 99 } }).agent.maxSteps).toBe(99)
    expect(normalizeSettings({ agent: { maxSteps: 500 } }).agent.maxSteps).toBe(500)
    expect(normalizeSettings({ agent: { maxSteps: 'много' } }).agent.maxSteps).toBe(DEFAULT_AGENT.maxSteps)
    expect(DEFAULT_AGENT.maxSteps).toBe(100)
  })

  it('keeps the flags and falls back on non-booleans', () => {
    const result = normalizeSettings({
      agent: { enabled: true, abortOnMouseMove: 'yes', verifyResult: false, showActions: false }
    })

    expect(result.agent.enabled).toBe(true)
    expect(result.agent.abortOnMouseMove).toBe(DEFAULT_AGENT.abortOnMouseMove)
    expect(result.agent.verifyResult).toBe(false)
    expect(result.agent.showActions).toBe(false)
  })

  it('drops a settings file written by the old plan runner', () => {
    // The old shape had per-action delays, a typing switch and a semantic
    // backend. None of them exist any more; reading them must not leave the
    // object with keys nothing reads, and must not fail on them either.
    const result = normalizeSettings({
      agent: {
        enabled: true, startDelayMs: 900, stepDelayMs: 420,
        allowTyping: false, allowShortcuts: false, semanticActions: false
      }
    })

    expect(Object.keys(result.agent).sort()).toEqual([
      'abortOnMouseMove', 'enabled', 'maxSteps', 'rememberedApprovals', 'showActions', 'verifyResult'
    ])
    expect(result.agent.enabled).toBe(true)
  })

  it('fills a missing block from the defaults', () => {
    expect(normalizeSettings({ agent: undefined }).agent).toEqual(DEFAULT_AGENT)
  })
})

describe('normalizeSettings: idempotence', () => {
  it('normalizing twice changes nothing', () => {
    const once = normalizeSettings({
      provider: 'anthropic',
      temperature: 0.9,
      maxTokens: 4000,
      hotkey: ' Cmd+J ',
      excludedApps: ['com.a', ' com.a '],
      voice: { model: 'small', language: 'EN', minDurationMs: 100 },
      agent: { maxSteps: 5 }
    })

    expect(normalizeSettings(once)).toEqual(once)
  })
})

describe('normalizeSettings: the answer voice', () => {
  it('is off by default, so a voice question is not read aloud unasked', () => {
    expect(normalizeSettings({}).voice.answerVoice).toBe('off')
  })

  it('accepts the three modes and rejects anything else', () => {
    for (const mode of ['off', 'system', 'neural'] as const) {
      expect(normalizeSettings({ voice: { answerVoice: mode } }).voice.answerVoice).toBe(mode)
    }
    expect(normalizeSettings({ voice: { answerVoice: 'loud' } }).voice.answerVoice).toBe('off')
  })

  it('reads the old boolean as the system voice it used to mean', () => {
    // `dialogue: true` spoke the answer with the macOS voice; that is exactly
    // `system` now, and an existing install must not lose the setting.
    expect(normalizeSettings({ voice: { dialogue: true } }).voice.answerVoice).toBe('system')
    expect(normalizeSettings({ voice: { dialogue: false } }).voice.answerVoice).toBe('off')
  })
})

describe('normalizeSettings: live synthesis', () => {
  it('is off and empty by default: no endpoint, no voice, no spend', () => {
    expect(normalizeSettings({}).tts).toEqual(DEFAULT_SETTINGS.tts)
    expect(DEFAULT_SETTINGS.tts.enabled).toBe(false)
  })

  it('keeps the configuration the user typed, trimmed', () => {
    const tts = normalizeSettings({
      tts: {
        enabled: true,
        baseUrl: ' https://speech.example/v1/audio/speech ',
        model: ' tts-model ',
        voice: ' Kore ',
        style: ' дружный '
      }
    }).tts

    expect(tts).toEqual({
      enabled: true,
      // The endpoint is normalised like a provider URL: a pasted path collapses
      // to the root instead of producing `.../audio/speech/audio/speech`.
      baseUrl: 'https://speech.example/v1',
      model: 'tts-model',
      voice: 'Kore',
      style: 'дружный'
    })
  })

  it('never carries a key: that lives in secrets, not in settings', () => {
    const settings = normalizeSettings({
      tts: { enabled: true, baseUrl: 'https://speech.example/v1', model: 'm', voice: 'v', key: 'sk-x' }
    })

    expect(settings.tts).not.toHaveProperty('key')
    expect(JSON.stringify(settings)).not.toContain('sk-x')
  })
})
