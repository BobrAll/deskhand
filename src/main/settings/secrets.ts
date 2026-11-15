/**
 * API keys live encrypted via Electron `safeStorage` (Keychain-backed on macOS).
 * The ciphertext is stored in electron-store; the plaintext only ever exists in
 * the main process memory for the duration of a request.
 */

import { app, safeStorage } from 'electron'
import Store from 'electron-store'
import { openRecoverableStore } from './recoverableStore'
import type { KeyStatus, ProviderId } from '@shared/types'
import { PROVIDERS } from '@shared/defaults'

interface SecretsSchema {
  secrets: Record<string, string>
}

let store: Store<SecretsSchema> | null = null

/**
 * Opens the secrets file, replacing it when it cannot be parsed.
 *
 * Without the recovery a corrupt `deskhand-secrets.json` makes every read throw,
 * which turns `keyStatuses()` and the whole settings bundle into a rejected
 * promise and leaves the settings window on «Не удалось загрузить настройки».
 */
function db(): Store<SecretsSchema> | null {
  store ??= openRecoverableStore({
    create: (clearInvalidConfig) =>
      new Store<SecretsSchema>({
        name: 'deskhand-secrets',
        defaults: { secrets: {} },
        ...(clearInvalidConfig ? { clearInvalidConfig: true } : {})
      }),
    probe: 'secrets',
    messages: {
      unreadable: '[secrets] secrets file is unreadable; the stored keys are lost:',
      resetFailed: '[secrets] unable to reset the secrets file:'
    }
  })
  return store
}

/** The stored slots as they are on disk; a corrupted one may not be a string. */
function readSecrets(): Record<string, unknown> {
  const opened = db()
  if (!opened) return {}
  try {
    const secrets: unknown = opened.get('secrets')
    return typeof secrets === 'object' && secrets !== null ? (secrets as Record<string, unknown>) : {}
  } catch (error) {
    console.warn('[secrets] unable to read the secrets file:', error)
    return {}
  }
}

/** The slots a key can be read from, ready to be written back. */
function storedSlots(): Record<string, string> {
  return Object.fromEntries(Object.entries(readSecrets()).filter(([, value]) => typeof value === 'string')) as Record<
    string,
    string
  >
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

/** True for a slot that holds something a key can be read from. */
function hasSlot(raw: unknown): raw is string {
  return typeof raw === 'string' && raw.length > 0
}

/** Reads and decrypts the key in one secrets slot. */
function readSlot(slot: string): string | null {
  const raw = readSecrets()[slot]
  // A hand-edited file or a slot another build left behind is not necessarily a
  // string; splitting or decrypting it would throw where "no key" is the answer.
  if (!hasSlot(raw)) return null
  const [scheme, payload] = raw.split(':', 2)
  if (!payload) return null
  if (scheme === 'plain') return Buffer.from(payload, 'base64').toString('utf8')
  // Anything that is not a scheme this app writes is not a key: it is a slot
  // some other build left behind, and there is nothing to decrypt.
  if (scheme !== 'enc') return null
  try {
    return safeStorage.decryptString(Buffer.from(payload, 'base64'))
  } catch (error) {
    // The slot exists but cannot be opened: a Keychain reset, or a settings file
    // copied from another Mac. Returning null keeps the caller's contract ("no
    // usable key"), and the card then asks for the key again — but without this
    // line the ciphertext is silently orphaned and nothing says why the key that
    // was entered a minute ago is being asked for.
    console.warn(`[secrets] stored key "${slot}" cannot be decrypted; asking for it again`, error)
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
  const opened = db()
  if (!opened) {
    console.warn(`[secrets] cannot save the key for "${slot}": the secrets file is unreadable`)
    return
  }
  const encoded = encryptionAvailable()
    ? `enc:${safeStorage.encryptString(trimmed).toString('base64')}`
    : // Should not happen on macOS; kept so the app still works if Keychain is locked.
      `plain:${Buffer.from(trimmed, 'utf8').toString('base64')}`
  try {
    opened.set('secrets', { ...storedSlots(), [slot]: encoded })
  } catch (error) {
    console.warn(`[secrets] unable to save the key for "${slot}"`, error)
  }
}

function deleteSlot(slot: string): void {
  const opened = db()
  if (!opened) return
  const secrets = storedSlots()
  delete secrets[slot]
  try {
    opened.set('secrets', secrets)
  } catch (error) {
    console.warn(`[secrets] unable to delete the key for "${slot}"`, error)
  }
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
  const secrets = readSecrets()
  return PROVIDERS.map((provider) => ({
    provider: provider.id,
    configured: hasSlot(secrets[provider.id]),
    encryptionAvailable: encryptionAvailable()
  }))
}
