/**
 * The settings recorder's stand-down switch.
 *
 * While the hotkey field is armed the app's global listeners have to be off:
 * otherwise the combination being typed is swallowed by the old binding and can
 * fire the old action mid-recording. The renderer normally ends the mode itself,
 * but its cleanup is a React unmount effect and does not run when the settings
 * window is destroyed. The window's `closed` hook therefore drives the same
 * switch, and this latch makes the two paths agree: the first ending wins and a
 * repeated `false` must not register the hotkey and start the voice tap again.
 */
export interface RecordingModeHooks {
  /** Silences the global hotkey and the voice tap. */
  standDown(): void
  /** Restores both from the settings store. */
  restore(): void
}

/** Returns the switch; a call with the value already in force does nothing. */
export function createRecordingMode(hooks: RecordingModeHooks): (active: boolean) => void {
  let recording = false
  return (active: boolean): void => {
    if (active === recording) return
    recording = active
    if (active) hooks.standDown()
    else hooks.restore()
  }
}
