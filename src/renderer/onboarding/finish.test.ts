import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '@shared/defaults'
import type { SettingsBundle } from '@shared/api'
import { finishState } from './finish'

const PERMISSIONS = { accessibility: true, screenRecording: true, microphone: true }

function bundle(overrides: { key?: boolean; model?: string } = {}): SettingsBundle {
  return {
    settings: { ...DEFAULT_SETTINGS, models: { ...DEFAULT_SETTINGS.models, openai: overrides.model ?? 'gpt-4o' } },
    keys: [{ provider: 'openai', configured: overrides.key ?? true, encryptionAvailable: true }],
    permissions: PERMISSIONS,
    encryptionAvailable: true
  }
}

describe('finishState', () => {
  it('does not claim readiness without a key', () => {
    expect(finishState(bundle({ key: false }), PERMISSIONS, 'openai').heading).toBe('Осталось добавить ключ')
  })

  it('does not claim readiness without a model', () => {
    expect(finishState(bundle({ model: '' }), PERMISSIONS, 'openai').heading).toBe('Осталось выбрать модель')
  })

  it('asks for the permission the assistant cannot work without', () => {
    expect(finishState(bundle(), { ...PERMISSIONS, accessibility: false }, 'openai').heading).toBe(
      'Разреши доступ и перезапусти'
    )
  })

  it('only says «Готово» when everything is in place', () => {
    expect(finishState(bundle(), PERMISSIONS, 'openai').heading).toBe('Готово')
  })

  it('describes the wizard selection, not the provider stored on disk', () => {
    const saved = { ...bundle(), settings: { ...DEFAULT_SETTINGS } }
    expect(finishState(saved, PERMISSIONS, 'anthropic').heading).toBe('Осталось добавить ключ')
  })
})
