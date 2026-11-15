/**
 * What the assistant is allowed to photograph for the card.
 *
 * The whole display is normally the right frame: the question may be about the
 * menu bar, the Dock or a second app. With excluded apps configured, that frame
 * is only safe while none of them has a window on screen. When one does — or
 * when the visible-window list cannot be read — the display may contain it, so
 * only the observed window is captured and a failed capture is not replaced
 * with a full-screen one.
 */

import type { ActiveAppInfo } from '@shared/types'
import { isExcluded } from '../context/activeApp'
import type { CaptureTarget } from '../context/screenshot'

export interface CaptureChoice {
  /** The window the system reports right now, or null when it could not be read. */
  observed: ActiveAppInfo | null
  /** The window the card was opened over, used when the card itself is in front. */
  remembered: ActiveAppInfo | null
  excludedApps: string[]
  /**
   * Bundle ids with an on-screen window right now, or null when the helper could
   * not answer. Unknown is treated like a visible exclusion: the safe way out.
   */
  visibleBundleIds: string[] | null
}

/** The capture to request, or null when nothing may be photographed. */
export function captureTargetFor(choice: CaptureChoice): CaptureTarget | null {
  const { observed, remembered, excludedApps, visibleBundleIds } = choice
  if (isExcluded(observed, excludedApps) || isExcluded(remembered, excludedApps)) return null

  const target: CaptureTarget = {
    windowId: observed?.windowId ?? remembered?.windowId ?? null,
    bounds: observed?.bounds ?? remembered?.bounds ?? null
  }
  if (excludedApps.length === 0) return { ...target, fullDisplay: true }

  const excludedVisible =
    visibleBundleIds === null || visibleBundleIds.some((bundleId) => excludedApps.includes(bundleId))
  if (excludedVisible) return { ...target, fullDisplay: false, allowFullScreenFallback: false }
  return { ...target, fullDisplay: true }
}
