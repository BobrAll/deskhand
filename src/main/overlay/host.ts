/**
 * The window contract the overlay controller drives.
 *
 * It lives apart from the controller because it is the seam between two files
 * that know nothing about each other's internals: `windows.ts` owns the
 * `BrowserWindow` and implements this, `overlay/index.ts` owns the session and
 * only calls it. Keeping the declaration here means neither side has to import
 * the other — `windows.ts` used to import the type from the controller module,
 * which made the controller look like a dependency of the window code when the
 * arrow only ever pointed the other way.
 */

import type { BrowserWindow } from 'electron'

export interface OverlayHost {
  /** Creates the window off-screen ahead of the first key press. */
  prewarm(): void
  /** Shows the window at the given size, positioned near the cursor. */
  show(height: number, width?: number): void
  /**
   * Shows it without taking focus.
   *
   * Push-to-talk uses this while it is still reading the frontmost app: a focused
   * overlay would become the "active app" the context is collected from.
   */
  showInactive(height: number, width?: number): void
  /**
   * Resizes the window, keeping it on screen.
   *
   * `pin` keeps the card's left edge and lets the far edge move. That is what a
   * drag on the right edge means: the edge under the pointer has to follow the
   * pointer, and only the card's own anchor would otherwise decide which side
   * grows.
   */
  resize(height: number, width?: number, pin?: boolean): void
  /**
   * Tells the window whether shapes are painted on the screen right now, so it
   * can drop its native blur while they are: a frosted card over the very spot
   * an arrow points at would smear the thing being pointed at.
   */
  setDrawing(active: boolean): void
  /** Drops the window's blur while a voice turn shows bare bars. */
  setVoice(active: boolean): void
  /**
   * Makes the card transparent to the mouse and gives up focus, so a synthetic
   * click lands on the app the plan is about instead of on our own panel.
   */
  setPassthrough(active: boolean): void
  hide(): void
  window(): BrowserWindow | null
}
