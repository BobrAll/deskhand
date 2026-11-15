/**
 * How onboarding writes a provider connection.
 *
 * The window mounts with one bundle and may save several providers into it. The
 * store answers every write with the bundle it now holds; spreading anything else
 * writes a stale model id and API root back over the provider that was just
 * configured — successfully, silently, and only visible much later.
 */

import { describe, expect, it } from 'vitest'
import type { SettingsBundle } from '@shared/api'
import { DEFAULT_SETTINGS } from '@shared/defaults'
import type { AppSettings } from '@shared/types'
import { saveConnection, type ConnectionStore } from './connection'

function bundle(settings: AppSettings): SettingsBundle {
  return {
    settings,
    keys: [],
    permissions: { accessibility: true, screenRecording: true, microphone: true },
    encryptionAvailable: true
  }
}

/** A store that keeps the last written settings, the way the real one does. */
function memoryStore(initial: AppSettings): ConnectionStore & { writes: AppSettings[] } {
  let current = initial
  const writes: AppSettings[] = []
  return {
    writes,
    async setKey() {
      return bundle(current)
    },
    async save(next) {
      writes.push(next)
      current = next
      return bundle(current)
    }
  }
}

const CONFIGURED: AppSettings = {
  ...DEFAULT_SETTINGS,
  provider: 'openai',
  models: { ...DEFAULT_SETTINGS.models, openai: 'gpt-4o' },
  baseUrls: { ...DEFAULT_SETTINGS.baseUrls, openai: 'https://proxy.example/v1' }
}

describe('saveConnection: one provider at a time', () => {
  it('keeps the provider that was saved first', async () => {
    const store = memoryStore(DEFAULT_SETTINGS)

    await saveConnection(store, {
      provider: 'openai',
      key: 'sk-openai',
      model: '  gpt-4o  ',
      baseUrl: 'https://proxy.example/v1'
    })
    await saveConnection(store, {
      provider: 'anthropic',
      key: 'sk-anthropic',
      model: 'claude-example',
      baseUrl: ''
    })

    expect(store.writes).toHaveLength(2)
    expect(store.writes[1].models.openai).toBe('gpt-4o')
    expect(store.writes[1].baseUrls.openai).toBe('https://proxy.example/v1')
    expect(store.writes[1].provider).toBe('anthropic')
    expect(store.writes[1].models.anthropic).toBe('claude-example')
    expect(store.writes[1].baseUrls.anthropic).toBe('')
  })

  it('writes the model as typed, without the surrounding spaces', async () => {
    const store = memoryStore(DEFAULT_SETTINGS)

    await saveConnection(store, {
      provider: 'openai',
      key: 'sk-openai',
      model: '  gpt-4o  ',
      baseUrl: ''
    })

    expect(store.writes[0].models.openai).toBe('gpt-4o')
  })

  it('answers with the bundle the store ended on', async () => {
    const store = memoryStore(CONFIGURED)

    const saved = await saveConnection(store, {
      provider: 'anthropic',
      key: 'sk-anthropic',
      model: 'claude-example',
      baseUrl: ''
    })

    expect(saved.settings.provider).toBe('anthropic')
    expect(saved.settings.models.openai).toBe('gpt-4o')
  })
})
