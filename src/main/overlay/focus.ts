import { app, BrowserWindow } from 'electron'
import type { ActiveAppInfo } from '@shared/types'
import { helperActivate } from '../native/helper'

interface FocusReturnHost {
  /** The overlay's own window, which must never become the fallback. */
  window(): BrowserWindow | null
  /** Whether the close that asked for the hand-back still owns the screen. */
  isCurrent(generation: number): boolean
}

export function createFocusReturn({ window, isCurrent }: FocusReturnHost) {
  /**
   * Gives the keyboard back to the app the user was working in.
   *
   * Two cases, and both used to leave the machine in a state where typing went
   * nowhere:
   *
   * - the remembered target still exists — it is activated, which is exactly what
   *   "return me where I was" means;
   * - there is no target (the app was on the exclusion list, or the frontmost app
   *   could not be read) — then the keyboard goes to one of our own windows when
   *   one is visible, and to the next application otherwise. The hand-off took
   *   those windows out of the candidate set, so it has to be explicit; a
   *   settings window the user opened on purpose is not something to close on
   *   their behalf.
   *
   * `closedIn` is the generation of the close that asked for this, because both
   * moves outlive it: the helper activation is a process round trip, and the
   * press that reopens the card can land inside that window. The new card took
   * the keyboard on purpose, so raising the old app over it — or hiding the
   * window it is in — would swallow the press.
   */
  async function returnFocusTo(target: ActiveAppInfo | null, closedIn: number): Promise<void> {
    if (!isCurrent(closedIn)) return
    if (target && (target.bundleId || target.pid > 0)) {
      try {
        if (await helperActivate({ bundleId: target.bundleId, pid: target.pid })) return
      } catch {
        /* fall through to hiding ourselves */
      }
    }
    // A reopen moved the generation while the helper was loading the app.
    if (!isCurrent(closedIn)) return
    const overlay = window()
    const fallback = BrowserWindow.getAllWindows().find(
      (win) =>
        win !== overlay &&
        !win.isDestroyed() &&
        win.isVisible() &&
        // Painting layers (the ghost pointer, drawings, the field mark) are
        // visible BrowserWindows that can never take the keyboard.
        win.isFocusable()
    )
    if (fallback) {
      // The hand-off took this window out of the keyboard candidate set, so the
      // automatic return no longer reaches it. Hand it back explicitly: the user
      // asked for this window, and with nothing to return to it is the honest
      // place for focus.
      fallback.show()
      fallback.focus()
      return
    }
    app.hide()
  }

  return { returnFocusTo }
}
