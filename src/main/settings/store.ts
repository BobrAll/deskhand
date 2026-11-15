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
import { openRecoverableStore } from './recoverableStore'
import type { AppSettings } from '@shared/types'

interface StoreShape {
  settings: AppSettings
}

let store: Store<StoreShape> | null = null
/** Set when the on-disk file was unusable during this run. */
let storeRecovered = false
/** Set when a patch could not reach the disk and lives only in memory. */
let writeFailed = false
/** Used when the file cannot be written: the newest value wins for this run. */
let memoryFallback: AppSettings | null = null

function db(): Store<StoreShape> | null {
  store ??= openRecoverableStore({
    create: (clearInvalidConfig) =>
      new Store<StoreShape>({
        name: 'deskhand',
        defaults: { settings: DEFAULT_SETTINGS },
        ...(clearInvalidConfig ? { clearInvalidConfig: true } : {})
      }),
    probe: 'settings',
    onCorrupt: () => {
      storeRecovered = true
    },
    messages: {
      unreadable: '[store] settings file is unreadable:',
      resetFailed: '[store] unable to reset the settings file:'
    }
  })
  return store
}

export function getSettings(): AppSettings {
  // A patch that could not be saved is still the value the user typed. Reading
  // the stale file back would silently undo it for the rest of the run.
  if (memoryFallback) return normalizeSettings(memoryFallback)
  const opened = db()
  if (!opened) {
    return normalizeSettings(DEFAULT_SETTINGS)
  }
  try {
    return normalizeSettings(opened.get('settings'))
  } catch (error) {
    console.warn('[store] unable to read settings, using defaults:', error)
    storeRecovered = true
    return normalizeSettings(DEFAULT_SETTINGS)
  }
}

/**
 * Persists a patch and returns the normalised result.
 *
 * A write that cannot reach the disk is kept in memory for the rest of the run
 * and reported through `settingsWriteFailed`, so the caller's value survives
 * even though a restart would lose it.
 */
export function patchSettings(patch: Partial<AppSettings>): AppSettings {
  const next = normalizeSettings({ ...getSettings(), ...patch })
  const opened = db()
  if (!opened) {
    // Nothing can be written at all; `settingsWriteFailed` is how a caller finds
    // out that this change will not survive a restart.
    memoryFallback = next
    writeFailed = true
    return next
  }
  try {
    opened.set('settings', next)
    memoryFallback = null
    writeFailed = false
  } catch (error) {
    console.warn(
      '[store] settings were not saved; the change lasts only until the app quits:',
      error
    )
    memoryFallback = next
    writeFailed = true
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

/**
 * True when the last write was dropped instead of saved.
 *
 * `patchSettings` already logs the dropped write; this probe is for tests and
 * for a caller that can tell the user. Nothing in the app reads it yet, because
 * the settings bundle's shared type has no field to carry it.
 */
export function settingsWriteFailed(): boolean {
  return writeFailed
}
