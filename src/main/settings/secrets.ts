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
    store = new Store<SecretsSchema>({ name: 'deskhand-secrets', defaults: { secrets: {} } })
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

/** Reads and decrypts the key in one secrets slot. */
function readSlot(slot: string): string | null {
  const raw = db().get('secrets')[slot]
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

/** Encrypts and stores a key; an empty key deletes the slot instead. */
function writeSlot(slot: string, key: string): void {
  const trimmed = key.trim()
  if (!trimmed) {
    deleteSlot(slot)
    return
  }
  const encoded = encryptionAvailable()
    ? `enc:${safeStorage.encryptString(trimmed).toString('base64')}`
    : // Should not happen on macOS; kept so the app still works if Keychain is locked.
      `plain:${Buffer.from(trimmed, 'utf8').toString('base64')}`
  db().set('secrets', { ...db().get('secrets'), [slot]: encoded })
}

function deleteSlot(slot: string): void {
  const secrets = { ...db().get('secrets') }
  delete secrets[slot]
  db().set('secrets', secrets)
}

export function getApiKey(provider: ProviderId): string | null {
  return readSlot(provider)
}

export function setApiKey(provider: ProviderId, key: string): void {
  writeSlot(provider, key)
}

export function deleteApiKey(provider: ProviderId): void {
  deleteSlot(provider)
}

/**
 * The key for live speech synthesis.
 *
 * Stored under a fixed slot next to the provider keys, encrypted the same way:
 * the endpoint is configurable, so it cannot be looked up by provider id. The
 * plaintext never leaves the main process, and no settings object carries it.
 */
const TTS_SLOT = 'tts'

export function getTtsKey(): string | null {
  return readSlot(TTS_SLOT)
}

export function setTtsKey(key: string): void {
  writeSlot(TTS_SLOT, key)
}

export function deleteTtsKey(): void {
  deleteSlot(TTS_SLOT)
}

export function keyStatuses(): KeyStatus[] {
  const secrets = db().get('secrets')
  return PROVIDERS.map((provider) => ({
    provider: provider.id,
    configured: Boolean(secrets[provider.id]),
    encryptionAvailable: encryptionAvailable()
  }))
}
