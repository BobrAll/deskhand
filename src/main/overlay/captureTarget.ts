/**
 * What the assistant is allowed to photograph for the card.
 *
 * With no excluded apps the whole display is the right frame: the question may
 * be about the menu bar, the Dock or a second app. With exclusions configured
 * that frame is a privacy leak — anything on the display can end up in the
 * image, including an app the user explicitly kept out — so only the observed
 * window is captured, and a failed window capture is not replaced with a
 * full-screen one.
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
}

/** The capture to request, or null when nothing may be photographed. */
export function captureTargetFor(choice: CaptureChoice): CaptureTarget | null {
  const { observed, remembered, excludedApps } = choice
  if (isExcluded(observed, excludedApps) || isExcluded(remembered, excludedApps)) return null

  const target: CaptureTarget = {
    windowId: observed?.windowId ?? remembered?.windowId ?? null,
    bounds: observed?.bounds ?? remembered?.bounds ?? null
  }
  if (excludedApps.length === 0) return { ...target, fullDisplay: true }
  return { ...target, fullDisplay: false, allowFullScreenFallback: false }
}
