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
/** Set when a patch could not reach the disk and lives only in memory. */
let writeFailed = false
/** Used when the file cannot be written: the newest value wins for this run. */
let memoryFallback: AppSettings | null = null

function openStore(clearInvalidConfig: boolean): Store<StoreShape> {
  return new Store<StoreShape>({
    name: 'deskhand',
    defaults: { settings: DEFAULT_SETTINGS },
    ...(clearInvalidConfig ? { clearInvalidConfig: true } : {})
  })
}

function db(): Store<StoreShape> | null {
  if (store) return store
  try {
    const first = openStore(false)
    // `conf` may parse the file in its constructor or lazily on the first read,
    // depending on the version, and `clearInvalidConfig` is honoured in the
    // getter either way. Probing here makes the corrupt-file case reachable no
    // matter which one it is, instead of trusting a constructor that can succeed
    // on a file every later read then throws on.
    first.get('settings')
    store = first
    return store
  } catch (error) {
    console.warn('[store] settings file is unreadable:', error)
  }
  try {
    // `clearInvalidConfig` makes the broken content count as empty instead of
    // throwing; the store then writes the defaults back over the file. The rest
    // of the Electron profile (caches, window state) is untouched.
    const reset = openStore(true)
    reset.get('settings')
    store = reset
    storeRecovered = true
    return store
  } catch (error) {
    console.error('[store] unable to reset the settings file:', error)
    storeRecovered = true
    return null
  }
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

/** Persists a patch and returns the normalised result. */
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
 * A lost settings save is otherwise indistinguishable from a saved one: the
 * value comes back from memory for the rest of the run and only disappears on
 * the next launch.
 */
export function settingsWriteFailed(): boolean {
  return writeFailed
}
