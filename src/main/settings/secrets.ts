/**
 * API keys live in `deskhand-secrets.json` next to the settings, with mode 0600.
 *
 * The file is the boundary, not a vault: another process running as the same
 * user can read it. Keys are never logged and leave this process only as an
 * `Authorization` header to the provider the user chose.
 */

import { chmodSync } from 'node:fs'
import Store from 'electron-store'
import { openRecoverableStore } from './recoverableStore'
import type { KeyStatus, ProviderId } from '@shared/types'
import { PROVIDERS } from '@shared/defaults'

interface SecretsSchema {
  secrets: Record<string, string>
}

/** Schemes an earlier, unreleased build wrote before keys became plain strings. */
const STALE_SCHEMES = ['enc:', 'plain:']

let store: Store<SecretsSchema> | null = null

/**
 * Drops keys written by the unreleased Keychain-backed storage.
 *
 * Leaving them would be worse than deleting them: they are not usable keys, but
 * they would still count as "configured" and be sent as a bearer token.
 */
function dropStaleSlots(opened: Store<SecretsSchema>): void {
  try {
    const secrets: unknown = opened.get('secrets')
    if (typeof secrets !== 'object' || secrets === null) return
    const entries = Object.entries(secrets as Record<string, unknown>)
    const kept = Object.fromEntries(
      entries.filter(
        ([, value]) => !(typeof value === 'string' && STALE_SCHEMES.some((scheme) => value.startsWith(scheme)))
      )
    )
    if (Object.keys(kept).length === entries.length) return
    opened.set('secrets', kept)
    console.warn('[secrets] dropped keys from a previous storage format; enter them again')
  } catch (error) {
    console.warn('[secrets] unable to clean up the secrets file:', error)
  }
}

/**
 * Makes the secrets file private to the user.
 *
 * `conf` writes with the process umask, which gave the file `0666` on a machine
 * seen in the wild. The process umask is narrowed at startup, and this call is
 * the repair path for a file written by an older build or with a wider umask.
 */
function restrictSecretsFile(opened: Store<SecretsSchema>): void {
  try {
    chmodSync(opened.path, 0o600)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn('[secrets] unable to restrict the secrets file permissions:', error)
    }
  }
}

/**
 * Opens the secrets file, replacing it when it cannot be parsed.
 *
 * Without the recovery a corrupt `deskhand-secrets.json` makes every read throw,
 * which turns `keyStatuses()` and the whole settings bundle into a rejected
 * promise and leaves the settings window on «Не удалось загрузить настройки».
 */
function db(): Store<SecretsSchema> | null {
  if (!store) {
    store = openRecoverableStore({
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
    if (store) {
      dropStaleSlots(store)
      restrictSecretsFile(store)
    }
  }
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

/** True for a slot that holds a key rather than blank space. */
function hasKey(raw: unknown): raw is string {
  return typeof raw === 'string' && raw.trim().length > 0
}

/** Reads the key in one secrets slot. */
function readSlot(slot: string): string | null {
  const raw = readSecrets()[slot]
  // A hand-edited file or a slot another build left behind is not necessarily a
  // string; pretending it is a key would fail later, where "no key" is an answer.
  return hasKey(raw) ? raw.trim() : null
}

/** Stores a key; an empty key deletes the slot instead. */
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
  try {
    opened.set('secrets', { ...storedSlots(), [slot]: trimmed })
    restrictSecretsFile(opened)
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
    restrictSecretsFile(opened)
  } catch (error) {
    console.warn(`[secrets] unable to delete the key for "${slot}"`, error)
  }
}

export function getApiKey(provider: ProviderId): string | null {
  return readSlot(provider)
}

/**
 * Whether a provider key exists, without loading it.
 *
 * Callers that only show "is a key configured?" use this instead of `getApiKey`
 * so the key itself is read only when a request is about to be sent.
 */
export function hasApiKey(provider: ProviderId): boolean {
  return hasKey(readSecrets()[provider])
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
 * Stored under a fixed slot next to the provider keys: the endpoint is
 * configurable, so it cannot be looked up by provider id. The plaintext never
 * leaves the main process, and no settings object carries it.
 */
const TTS_SLOT = 'tts'

export function getTtsKey(): string | null {
  return readSlot(TTS_SLOT)
}

/** Whether a speech key exists, without loading it; see `hasApiKey`. */
export function hasTtsKey(): boolean {
  return hasKey(readSecrets()[TTS_SLOT])
}

export function setTtsKey(key: string): void {
  writeSlot(TTS_SLOT, key)
}

export function deleteTtsKey(): void {
  deleteSlot(TTS_SLOT)
}

/** What the settings window shows at a glance, without reading a key. */
export function keyStatuses(): KeyStatus[] {
  const secrets = readSecrets()
  return PROVIDERS.map((provider) => ({
    provider: provider.id,
    configured: hasKey(secrets[provider.id])
  }))
}
