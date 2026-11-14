/**
 * Opening a store whose file may be unreadable.
 *
 * `conf` parses the file on the first read, and only there does
 * `clearInvalidConfig` apply; without it a corrupt file makes every later read
 * throw, which turns a settings load into a rejected promise. The flag cannot be
 * passed blindly either: a store created with it would repair the file silently.
 * So the file is probed plainly first, and only a failed probe is retried with
 * `clearInvalidConfig`, which makes the broken content count as empty.
 */

/** The part of `Store` the probe needs, so the helper does not pin a schema. */
interface ReadableStore {
  get(key: string): unknown
}

export interface RecoverableStoreOptions<Opened extends ReadableStore> {
  /** Creates the store; the flag repairs a broken file instead of throwing on it. */
  create(clearInvalidConfig: boolean): Opened
  /** The key whose read parses the file, so a broken one is found now. */
  probe: string
  /** Called when the plain open failed: the file was replaced or bypassed. */
  onCorrupt?: () => void
  /** The caller's own log lines, so each store keeps its wording. */
  messages: {
    unreadable: string
    resetFailed: string
  }
}

/**
 * Opens the store, or returns null when even the repairing open fails.
 *
 * The first attempt is deliberate: it is what makes a corrupt file visible in
 * the log instead of silently replaced.
 */
export function openRecoverableStore<Opened extends ReadableStore>(
  options: RecoverableStoreOptions<Opened>
): Opened | null {
  try {
    const store = options.create(false)
    store.get(options.probe)
    return store
  } catch (error) {
    console.warn(options.messages.unreadable, error)
    options.onCorrupt?.()
  }
  try {
    const store = options.create(true)
    store.get(options.probe)
    return store
  } catch (error) {
    console.error(options.messages.resetFailed, error)
    return null
  }
}
