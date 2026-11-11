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
  cache: new Map<string, Buffer>(),
  calls: [] as Array<Record<string, unknown>>
}))

const local = vi.hoisted(() => ({
  binary: null as string | null,
  voice: false,
  file: 'ru_RU-ruslan-medium.onnx',
  calls: [] as string[],
  result: { ok: true, audio: '', cached: false, mime: 'audio/wav' } as TtsResult
}))

vi.mock('./piper', () => ({
  piperBinary: () => local.binary,
  piperModel: () => local.voice ? `/voices/${local.file}` : null,
  synthesizePiper: async (text: string) => {
    local.calls.push(text)
    return local.result
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
    writeFile: async (path: string, data: Buffer) => { fake.cache.set(path, data) },
    readFile: async (path: string) => {
      const hit = fake.cache.get(path)
      if (!hit) throw new Error('ENOENT')
      return hit
    },
    readdir: async () => [...fake.cache.keys()].map((path) => path.split('/').pop() as string),
    stat: async () => ({ mtimeMs: 0 }),
    unlink: async (path: string) => { fake.cache.delete(path) }
  }
})

vi.mock('../settings/store', () => ({ getSettings: () => fake.settings }))
vi.mock('../settings/secrets', () => ({ getTtsKey: () => fake.key }))

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
    style: 'дружный'
  }
}

const LOCAL: AppSettings = {
  ...CONFIGURED,
  tts: {
    ...CONFIGURED.tts,
    engine: 'piper'
  }
}

beforeEach(() => {
  fake.settings = CONFIGURED
  fake.key = 'sk-test'
  fake.cache.clear()
  fake.calls = []
  local.binary = null
  local.voice = false
  local.file = 'ru_RU-ruslan-medium.onnx'
  local.calls = []
  local.result = { ok: true, audio: '', cached: false, mime: 'audio/wav' }
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    fake.calls.push({ url, body: JSON.parse(String(init.body)) })
    return new Response(new Uint8Array([1, 2, 3]), {
      status: 200,
      headers: { 'Content-Type': 'audio/mpeg' }
    })
  }))
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

describe('live synthesis', () => {
  it('is off until every part of the configuration is present', async () => {
    const { ttsBlockReason } = await load()
    expect(ttsBlockReason(CONFIGURED)).toBeNull()
    expect(ttsBlockReason({ ...CONFIGURED, tts: { ...CONFIGURED.tts, enabled: false } }))
      .toContain('выключен')
    expect(ttsBlockReason({ ...CONFIGURED, tts: { ...CONFIGURED.tts, baseUrl: '' } }))
      .toContain('адрес')
    expect(ttsBlockReason({ ...CONFIGURED, tts: { ...CONFIGURED.tts, model: '' } }))
      .toContain('модель')
    expect(ttsBlockReason({ ...CONFIGURED, tts: { ...CONFIGURED.tts, voice: '' } }))
      .toContain('голос')
    fake.key = null
    expect(ttsBlockReason(CONFIGURED)).toContain('ключ')
  })

  it('sends the user\'s endpoint, model, voice and style, and nothing else', async () => {
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
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 400 })))
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
})

describe('the local engine', () => {
  it('does not send a local-only line to the remote service after an engine change', async () => {
    const { synthesize } = await load()
    const result = await synthesize('Готово.', true)
    expect(result.ok).toBe(false)
    expect(fake.calls).toHaveLength(0)
  })

  it('needs the bundled engine and model', async () => {
    const { ttsBlockReason } = await load()
    expect(ttsBlockReason(LOCAL)).toContain('движка Piper')

    local.binary = '/piper/piper'
    expect(ttsBlockReason(LOCAL)).toContain('Руслан')

    local.voice = true
    expect(ttsBlockReason(LOCAL)).toBeNull()
  })

  it('speaks through Piper and caches a WAV instead of calling the service', async () => {
    local.binary = '/piper/piper'
    local.voice = true
    local.result = { ok: true, audio: 'AAA', cached: false, mime: 'audio/wav' }
    fake.settings = LOCAL

    const { synthesize } = await load()
    const result = await synthesize('Готово.')
    expect(result).toMatchObject({ ok: true, mime: 'audio/wav' })
    expect(local.calls).toEqual(['Готово.'])
    expect(fake.calls).toHaveLength(0)

    const again = await synthesize('Готово.')
    expect(again).toMatchObject({ ok: true, cached: true, mime: 'audio/wav' })
    expect(local.calls).toHaveLength(1)
  })

  it('keeps caches distinct when the bundled model path changes', async () => {
    local.binary = '/piper/piper'
    local.voice = true
    fake.settings = LOCAL

    const { synthesize } = await load()
    await synthesize('Готово.')
    local.file = 'updated/ru_RU-ruslan-medium.onnx'
    await synthesize('Готово.')

    expect(local.calls).toHaveLength(2)
    expect(fake.calls).toHaveLength(0)
  })
})
