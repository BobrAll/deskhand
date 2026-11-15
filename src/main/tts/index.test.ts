/**
 * Live synthesis: configuration, caching and failure.
 *
 * The properties worth pinning down here are the ones a person cannot see from
 * the settings pane: that the key is not part of the settings object, that a
 * change of voice is a different cache entry rather than the old voice's file,
 * and that every failure degrades to "speak with the system voice" instead of
 * throwing into a turn.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '@shared/defaults'
import type { AppSettings } from '@shared/types'
import type { TtsResult } from '@shared/tts'

const fake = vi.hoisted(() => ({
  settings: {} as AppSettings,
  key: null as string | null,
  keyUnreadable: false,
  cache: new Map<string, Buffer>(),
  calls: [] as Array<Record<string, unknown>>
}))

const silero = vi.hoisted(() => ({
  runtime: false,
  models: false,
  calls: [] as Array<[string, string]>,
  result: { ok: true, audio: '', cached: false, mime: 'audio/wav' } as TtsResult
}))

const pronounce = vi.hoisted(() => ({
  hints: {} as Record<string, string>,
  calls: [] as string[],
  prefetch: [] as string[]
}))

vi.mock('./pronounce', () => ({
  resolvePronunciations: async (text: string) => {
    pronounce.calls.push(text)
    return pronounce.hints
  },
  prefetchHints: async (text: string) => {
    pronounce.prefetch.push(text)
  }
}))

vi.mock('./silero', () => ({
  SILERO_CACHE_ID: 'silero-test',
  TRANSLITERATION_VERSION: 1,
  sileroRuntimeReady: () => silero.runtime,
  sileroModelsReady: () => silero.models,
  synthesizeSilero: async (text: string, speaker: string) => {
    silero.calls.push([text, speaker])
    return silero.result
  }
}))

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/deskhand-test' }
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    mkdir: async () => undefined,
    writeFile: async (path: string, data: Buffer) => {
      fake.cache.set(path, data)
    },
    readFile: async (path: string) => {
      const hit = fake.cache.get(path)
      if (!hit) throw new Error('ENOENT')
      return hit
    },
    readdir: async () => [...fake.cache.keys()].map((path) => path.split('/').pop() as string),
    stat: async () => ({ mtimeMs: 0 }),
    unlink: async (path: string) => {
      fake.cache.delete(path)
    }
  }
})

vi.mock('../settings/store', () => ({ getSettings: () => fake.settings }))
vi.mock('../settings/secrets', () => ({
  getTtsKey: () => {
    if (fake.keyUnreadable) throw new Error('the secrets store is unreadable')
    return fake.key
  }
}))

async function load() {
  return import('./index')
}

const CONFIGURED: AppSettings = {
  ...DEFAULT_SETTINGS,
  tts: {
    enabled: true,
    engine: 'remote',
    baseUrl: 'https://speech.example/v1',
    model: 'tts-model',
    voice: 'Kore',
    style: 'дружный',
    sileroVoice: 'xenia',
    pronunciationLookup: true
  }
}

const SILERO: AppSettings = {
  ...CONFIGURED,
  tts: {
    ...CONFIGURED.tts,
    engine: 'silero',
    sileroVoice: 'baya'
  }
}

beforeEach(() => {
  fake.settings = CONFIGURED
  fake.key = 'sk-test'
  fake.keyUnreadable = false
  fake.cache.clear()
  fake.calls = []
  silero.runtime = false
  silero.models = false
  silero.calls = []
  silero.result = { ok: true, audio: '', cached: false, mime: 'audio/wav' }
  pronounce.hints = {}
  pronounce.calls = []
  pronounce.prefetch = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      fake.calls.push({ url, body: JSON.parse(String(init.body)) })
      return new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { 'Content-Type': 'audio/mpeg' }
      })
    })
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

describe('live synthesis', () => {
  it('is off until every part of the configuration is present', async () => {
    const { ttsBlockReason } = await load()
    expect(ttsBlockReason(CONFIGURED)).toBeNull()
    expect(ttsBlockReason({ ...CONFIGURED, tts: { ...CONFIGURED.tts, enabled: false } })).toContain('выключен')
    expect(ttsBlockReason({ ...CONFIGURED, tts: { ...CONFIGURED.tts, baseUrl: '' } })).toContain('адрес')
    expect(ttsBlockReason({ ...CONFIGURED, tts: { ...CONFIGURED.tts, model: '' } })).toContain('модель')
    expect(ttsBlockReason({ ...CONFIGURED, tts: { ...CONFIGURED.tts, voice: '' } })).toContain('голос')
    fake.key = null
    expect(ttsBlockReason(CONFIGURED)).toContain('ключ')
  })

  it("sends the user's endpoint, model, voice and style, and nothing else", async () => {
    const { synthesize } = await load()
    const result = await synthesize('Готово.')
    expect(result.ok).toBe(true)
    expect(fake.calls).toHaveLength(1)
    expect(fake.calls[0].url).toBe('https://speech.example/v1/audio/speech')
    expect(fake.calls[0].body).toMatchObject({
      model: 'tts-model',
      voice: 'Kore',
      instructions: 'дружный',
      input: 'Готово.'
    })
  })

  it('pays for a sentence once, and never for the same sentence in another voice', async () => {
    const { synthesize } = await load()
    await synthesize('Готово.')
    const again = await synthesize('Готово.')
    expect(fake.calls).toHaveLength(1)
    expect(again).toMatchObject({ ok: true, cached: true })

    fake.settings = { ...CONFIGURED, tts: { ...CONFIGURED.tts, voice: 'Puck' } }
    await synthesize('Готово.')
    expect(fake.calls).toHaveLength(2)
    // A changed voice must not reuse the previous voice's audio.
    expect(fake.calls[1].body).toMatchObject({ voice: 'Puck' })
  })

  it('degrades instead of throwing when the service refuses', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 400 }))
    )
    const { synthesize } = await load()
    const result = await synthesize('Готово.')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain('400')
  })

  it('does not call the service at all when it is not configured', async () => {
    fake.key = null
    const { synthesize } = await load()
    const result = await synthesize('Готово.')
    expect(result.ok).toBe(false)
    expect(fake.calls).toHaveLength(0)
  })

  it('treats an unreadable key as a missing one instead of throwing', async () => {
    fake.keyUnreadable = true
    const { synthesize, ttsBlockReason, ttsStatus } = await load()

    expect(ttsBlockReason(CONFIGURED)).toContain('ключ')
    const status = ttsStatus()
    expect(status.keyConfigured).toBe(false)
    expect(status.configured).toBe(false)

    const result = await synthesize('Готово.')
    expect(result.ok).toBe(false)
    expect(fake.calls).toHaveLength(0)
  })

  it('refuses a local-only line when the configured engine is the remote one', async () => {
    const { synthesize } = await load()
    const result = await synthesize('Готово.', true)
    expect(result).toMatchObject({ ok: false, message: 'Локальный синтез выключен.' })
    expect(fake.calls).toHaveLength(0)
  })
})

describe('the Silero engine', () => {
  it('explains which half is missing instead of failing at synthesis', async () => {
    const { ttsBlockReason } = await load()
    expect(ttsBlockReason(SILERO)).toContain('не установлен')

    silero.runtime = true
    expect(ttsBlockReason(SILERO)).toContain('Нет модели')

    silero.models = true
    expect(ttsBlockReason(SILERO)).toBeNull()
  })

  it('speaks with the chosen speaker, caches a WAV, and never calls the service', async () => {
    silero.runtime = true
    silero.models = true
    silero.result = { ok: true, audio: 'AAA', cached: false, mime: 'audio/wav' }
    fake.settings = SILERO

    const { synthesize } = await load()
    const result = await synthesize('Готово.')
    expect(result).toMatchObject({ ok: true, mime: 'audio/wav' })
    expect(silero.calls).toEqual([['Готово.', 'baya']])
    expect(fake.calls).toHaveLength(0)

    const again = await synthesize('Готово.')
    expect(again).toMatchObject({ ok: true, cached: true })
    expect(silero.calls).toHaveLength(1)
  })

  it('does not reuse a clip spoken before a pronunciation hint arrived', async () => {
    silero.runtime = true
    silero.models = true
    fake.settings = SILERO

    const { synthesize } = await load()
    await synthesize('localhost')
    expect(silero.calls).toHaveLength(1)

    pronounce.hints = { localhost: 'локалх+ост' }
    await synthesize('localhost')
    expect(silero.calls).toHaveLength(2)
  })

  it('reports the engine and the installed state to the settings pane', async () => {
    fake.settings = SILERO
    silero.runtime = true
    const { ttsStatus } = await load()
    const status = ttsStatus()
    expect(status.engine).toBe('silero')
    expect(status.voice).toBe('baya')
    expect(status.silero).toEqual({ installed: false })
    expect(status.configured).toBe(false)
    expect(status.reason).toContain('Нет модели')
  })
})

describe('prefetching pronunciation hints', () => {
  it('does not ask while the local engine cannot synthesise', async () => {
    fake.settings = SILERO
    silero.runtime = true
    silero.models = false

    const { prefetchPronunciations } = await load()
    prefetchPronunciations('Открой Figma')
    expect(pronounce.prefetch).toEqual([])
  })

  it('does not ask when synthesis is switched off', async () => {
    fake.settings = { ...SILERO, tts: { ...SILERO.tts, enabled: false } }
    silero.runtime = true
    silero.models = true

    const { prefetchPronunciations } = await load()
    prefetchPronunciations('Открой Figma')
    expect(pronounce.prefetch).toEqual([])
  })

  it('warms the cache when the local engine is ready', async () => {
    fake.settings = SILERO
    silero.runtime = true
    silero.models = true

    const { prefetchPronunciations } = await load()
    prefetchPronunciations('Открой Figma')
    expect(pronounce.prefetch).toEqual(['Открой Figma'])
  })
})
