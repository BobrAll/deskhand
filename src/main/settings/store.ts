/**
 * Persistent, non-secret settings in `electron-store`.
 * API keys deliberately live elsewhere (see `secrets.ts`).
 *
 * The store is treated as untrusted input: a corrupt or unreadable file must
 * never take the app down. Settings are read on the startup path (tray menu →
 * bootstrap → IPC registration), so a throw here would leave the settings
 * window with no IPC handlers at all — it would open and stay empty.
 */

import Store from 'electron-store'
import { DEFAULT_SETTINGS, normalizeSettings } from '@shared/defaults'
import type { AppSettings } from '@shared/types'

interface StoreShape {
  settings: AppSettings
}

let store: Store<StoreShape> | null = null
/** Set when the on-disk file was unusable during this run. */
let storeRecovered = false
/** Used only if even a reset store cannot be opened. */
let memoryFallback: AppSettings | null = null

function db(): Store<StoreShape> | null {
  if (store) return store
  try {
    store = new Store<StoreShape>({
      name: 'deskhand',
      defaults: { settings: DEFAULT_SETTINGS }
    })
    return store
  } catch (error) {
    console.warn('[store] settings file is unreadable:', error)
  }
  try {
    // `clearInvalidConfig` rewrites just the broken file, keeping the rest of
    // the Electron profile (caches, window state) intact.
    store = new Store<StoreShape>({
      name: 'deskhand',
      defaults: { settings: DEFAULT_SETTINGS },
      clearInvalidConfig: true
    })
    storeRecovered = true
    return store
  } catch (error) {
    console.error('[store] unable to reset the settings file:', error)
    storeRecovered = true
    return null
  }
}

export function getSettings(): AppSettings {
  const opened = db()
  if (!opened) {
    return normalizeSettings(memoryFallback ?? DEFAULT_SETTINGS)
  }
  try {
    return normalizeSettings(opened.get('settings'))
  } catch (error) {
    console.warn('[store] unable to read settings, using defaults:', error)
    storeRecovered = true
    return normalizeSettings(DEFAULT_SETTINGS)
  }
}

/** Persists a patch and returns the normalised result. */
export function patchSettings(patch: Partial<AppSettings>): AppSettings {
  const next = normalizeSettings({ ...getSettings(), ...patch })
  const opened = db()
  if (!opened) {
    memoryFallback = next
    return next
  }
  try {
    opened.set('settings', next)
  } catch (error) {
    console.warn('[store] unable to persist settings, keeping them in memory:', error)
    memoryFallback = next
  }
  return next
}

/**
 * True when the stored file had to be discarded or bypassed during this run.
 *
 * Exists for the store tests: recovery is otherwise silent, and this is the only
 * way to observe that the corrupt file was actually replaced.
 */
export function settingsWereRecovered(): boolean {
  return storeRecovered
}
