import { describe, expect, it } from 'vitest'

import {
  DEFAULT_AGENT,
  DEFAULT_EXCLUDED_APPS,
  DEFAULT_GESTURES,
  DEFAULT_QUICK_ACTIONS,
  DEFAULT_SETTINGS,
  DEFAULT_SYSTEM_PROMPT,
  DEFAULT_VOICE,
  normalizeSettings
} from './defaults'

// `models` is the one block that does not fall back to the shipped defaults: an
// empty bag normalizes to empty model names (see the note in PROGRESS).
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
    expect(result.quickActions).toEqual(DEFAULT_QUICK_ACTIONS)
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
      agent: { ...DEFAULT_AGENT, extra: 2 },
      gestures: { ...DEFAULT_GESTURES, extra: 3 }
    })

    expect(result.voice).not.toHaveProperty('extra')
    expect(result.agent).not.toHaveProperty('extra')
    expect(result.gestures).not.toHaveProperty('extra')
  })
})

describe('normalizeSettings: a renamed key silently loses its value', () => {
  it('drops a key that was renamed on disk', () => {
    // Old builds wrote `hideOnBlur`; the current name is `hideOverlayOnBlur`.
    const result = normalizeSettings({ hideOnBlur: true })

    expect(result.hideOverlayOnBlur).toBe(DEFAULT_SETTINGS.hideOverlayOnBlur)
    expect(result).not.toHaveProperty('hideOnBlur')
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
    expect(normalizeSettings({ hideOverlayOnBlur: true }).hideOverlayOnBlur).toBe(true)
    expect(normalizeSettings({ hideOverlayOnBlur: 'true' }).hideOverlayOnBlur).toBe(false)
    expect(normalizeSettings({ captureScreenshotByDefault: false }).captureScreenshotByDefault).toBe(
      false
    )
    expect(normalizeSettings({ launchAtLogin: 1 }).launchAtLogin).toBe(false)
    expect(normalizeSettings({ onboardingCompleted: 'yes' }).onboardingCompleted).toBe(false)
  })
})

describe('normalizeSettings: quickActions', () => {
  it('keeps a valid list', () => {
    const result = normalizeSettings({
      quickActions: [
        { id: 'a', label: 'A', prompt: 'сделай A', mode: 'insert' },
        { id: 'b', label: 'B', prompt: 'сделай B', mode: 'analyze' }
      ]
    })

    expect(result.quickActions).toEqual([
      { id: 'a', label: 'A', prompt: 'сделай A', mode: 'insert' },
      { id: 'b', label: 'B', prompt: 'сделай B', mode: 'analyze' }
    ])
  })

  it('falls back to the defaults when the value is not an array', () => {
    for (const value of [undefined, null, 'x', 42, { id: 'a' }]) {
      expect(normalizeSettings({ quickActions: value }).quickActions, String(value)).toEqual(
        DEFAULT_QUICK_ACTIONS
      )
    }
  })

  it('falls back to the defaults when every entry is unusable', () => {
    expect(normalizeSettings({ quickActions: [] }).quickActions).toEqual(DEFAULT_QUICK_ACTIONS)
    expect(
      normalizeSettings({ quickActions: [{ label: '', prompt: '' }, null, 42, 'x'] }).quickActions
    ).toEqual(DEFAULT_QUICK_ACTIONS)
  })

  it('drops entries without a label or without a prompt', () => {
    const result = normalizeSettings({
      quickActions: [
        { id: 'a', label: 'A', prompt: 'P' },
        { id: 'b', label: '  ', prompt: 'P' },
        { id: 'c', label: 'C', prompt: '   ' }
      ]
    })

    expect(result.quickActions.map((action) => action.id)).toEqual(['a'])
  })

  it('generates an id from the position when it is missing', () => {
    const result = normalizeSettings({
      quickActions: [
        { id: '  ', label: 'A', prompt: 'P' },
        { label: 'B', prompt: 'P' }
      ]
    })

    expect(result.quickActions.map((action) => action.id)).toEqual(['action-1', 'action-2'])
  })

  it('truncates a label at 40 characters', () => {
    const result = normalizeSettings({
      quickActions: [{ id: 'a', label: 'я'.repeat(60), prompt: 'P' }]
    })

    expect(result.quickActions[0].label).toHaveLength(40)
  })

  it('treats any mode other than analyze as insert', () => {
    const result = normalizeSettings({
      quickActions: [
        { id: 'a', label: 'A', prompt: 'P', mode: 'analyze' },
        { id: 'b', label: 'B', prompt: 'P', mode: 'что-то' },
        { id: 'c', label: 'C', prompt: 'P' }
      ]
    })

    expect(result.quickActions.map((action) => action.mode)).toEqual(['analyze', 'insert', 'insert'])
  })

  it('replaces non-string labels and prompts with empty strings, dropping the entry', () => {
    const result = normalizeSettings({
      quickActions: [
        { id: 'a', label: 42, prompt: 'P' },
        { id: 'b', label: 'B', prompt: { text: 'P' } },
        { id: 'c', label: 'C', prompt: 'P' }
      ]
    })

    expect(result.quickActions.map((action) => action.id)).toEqual(['c'])
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

describe('normalizeSettings: gestures', () => {
  it('always forces three fingers', () => {
    expect(normalizeSettings({ gestures: { fingers: 2 } }).gestures.fingers).toBe(3)
    expect(normalizeSettings({ gestures: { fingers: 4 } }).gestures.fingers).toBe(3)
  })

  it('clamps holdMs to 250..900', () => {
    expect(normalizeSettings({ gestures: { holdMs: 10 } }).gestures.holdMs).toBe(250)
    expect(normalizeSettings({ gestures: { holdMs: 5000 } }).gestures.holdMs).toBe(900)
    expect(normalizeSettings({ gestures: { holdMs: 500.4 } }).gestures.holdMs).toBe(500)
  })

  it('fills a missing block from the defaults', () => {
    expect(normalizeSettings({ gestures: null }).gestures).toEqual(DEFAULT_GESTURES)
  })
})

describe('normalizeSettings: agent', () => {
  it('clamps the delays and the step count', () => {
    const result = normalizeSettings({
      agent: { startDelayMs: -1, stepDelayMs: 99999, maxSteps: 0 }
    })

    expect(result.agent.startDelayMs).toBe(0)
    expect(result.agent.stepDelayMs).toBe(5000)
    expect(result.agent.maxSteps).toBe(1)
    expect(normalizeSettings({ agent: { maxSteps: 99 } }).agent.maxSteps).toBe(8)
  })

  it('keeps the flags and falls back on non-booleans', () => {
    const result = normalizeSettings({
      agent: { enabled: true, allowTyping: false, allowShortcuts: 'yes', verifyResult: false }
    })

    expect(result.agent.enabled).toBe(true)
    expect(result.agent.allowTyping).toBe(false)
    expect(result.agent.allowShortcuts).toBe(DEFAULT_AGENT.allowShortcuts)
    expect(result.agent.verifyResult).toBe(false)
    expect(result.agent.abortOnMouseMove).toBe(DEFAULT_AGENT.abortOnMouseMove)
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
      gestures: { holdMs: 400 },
      agent: { maxSteps: 5 }
    })

    expect(normalizeSettings(once)).toEqual(once)
  })
})
