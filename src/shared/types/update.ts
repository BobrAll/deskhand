/**
 * Self-update state shared by the main process, the settings window and the
 * tray. The update is always user-driven: nothing installs itself, the app
 * only finds the new release, downloads it after a click and swaps the bundle
 * after a second click.
 */

/** Where the update flow is right now. */
export type UpdatePhase = 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'error'

export interface UpdateState {
  phase: UpdatePhase
  /** The version that is running. */
  current: string
  /** The newer version found by the last successful check, if any. */
  latest: string | null
  /** 0..1 while `downloading`; null in every other phase. */
  progress: number | null
  /** Download size from the release asset, for the «148 МБ» hint. */
  sizeBytes: number | null
  /** One sentence in Russian while `phase === 'error'`. */
  message: string | null
  /** Which action «Попробовать ещё раз» repeats after an error. */
  retry: 'check' | 'download' | null
  /** The last check ran through and found nothing newer. */
  upToDate: boolean
}
