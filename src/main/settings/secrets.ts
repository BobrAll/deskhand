/**
 * API keys live encrypted via Electron `safeStorage` (Keychain-backed on macOS).
 * The ciphertext is stored in electron-store; the plaintext only ever exists in
 * the main process memory for the duration of a request.
 */

import { app, safeStorage } from 'electron'
import Store from 'electron-store'
import type { KeyStatus, ProviderId } from '@shared/types'
import { PROVIDERS } from '@shared/defaults'

interface SecretsSchema {
  secrets: Record<string, string>
}

let store: Store<SecretsSchema> | null = null

function db(): Store<SecretsSchema> {
  if (!store) {
    store = new Store<SecretsSchema>({ name: 'smart-cursor-secrets', defaults: { secrets: {} } })
  }
  return store
}

/** safeStorage is only usable after `app.ready`. */
export function encryptionAvailable(): boolean {
  if (!app.isReady()) return false
  try {
    return safeStorage.isEncryptionAvailable()
  } catch {
    return false
  }
}

export function getApiKey(provider: ProviderId): string | null {
  const raw = db().get('secrets')[provider]
  if (!raw) return null
  const [scheme, payload] = raw.split(':', 2)
  if (!payload) return null
  if (scheme === 'plain') return Buffer.from(payload, 'base64').toString('utf8')
  try {
    return safeStorage.decryptString(Buffer.from(payload, 'base64'))
  } catch {
    return null
  }
}

export function setApiKey(provider: ProviderId, key: string): void {
  const trimmed = key.trim()
  if (!trimmed) {
    deleteApiKey(provider)
    return
  }
  const encoded = encryptionAvailable()
    ? `enc:${safeStorage.encryptString(trimmed).toString('base64')}`
    : // Should not happen on macOS; kept so the app still works if Keychain is locked.
      `plain:${Buffer.from(trimmed, 'utf8').toString('base64')}`
  db().set('secrets', { ...db().get('secrets'), [provider]: encoded })
}

export function deleteApiKey(provider: ProviderId): void {
  const secrets = { ...db().get('secrets') }
  delete secrets[provider]
  db().set('secrets', secrets)
}

export function keyStatuses(): KeyStatus[] {
  const secrets = db().get('secrets')
  return PROVIDERS.map((provider) => ({
    provider: provider.id,
    configured: Boolean(secrets[provider.id]),
    encryptionAvailable: encryptionAvailable()
  }))
}