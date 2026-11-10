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

const fake = vi.hoisted(() => ({
  settings: {} as AppSettings,
  key: null as string | null,
  cache: new Map<string, Buffer>(),
  calls: [] as Array<Record<string, unknown>>
}))

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/smart-cursor-test' }
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
    baseUrl: 'https://speech.example/v1',
    model: 'tts-model',
    voice: 'Kore',
    style: 'дружный'
  }
}

beforeEach(() => {
  fake.settings = CONFIGURED
  fake.key = 'sk-test'
  fake.cache.clear()
  fake.calls = []
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
    const { speechBlockReason } = await load()
    expect(speechBlockReason(CONFIGURED)).toBeNull()
    expect(speechBlockReason({ ...CONFIGURED, tts: { ...CONFIGURED.tts, enabled: false } }))
      .toContain('выключен')
    expect(speechBlockReason({ ...CONFIGURED, tts: { ...CONFIGURED.tts, baseUrl: '' } }))
      .toContain('адрес')
    expect(speechBlockReason({ ...CONFIGURED, tts: { ...CONFIGURED.tts, model: '' } }))
      .toContain('модель')
    expect(speechBlockReason({ ...CONFIGURED, tts: { ...CONFIGURED.tts, voice: '' } }))
      .toContain('голос')
    fake.key = null
    expect(speechBlockReason(CONFIGURED)).toContain('ключ')
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
