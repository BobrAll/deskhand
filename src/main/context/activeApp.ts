/**
 * "Which application is the user working in?"
 *
 * Must be called *before* the overlay is shown: as soon as our own window takes
 * focus, the frontmost app is us.
 */

import type { ActiveAppInfo } from '@shared/types'
import { helperFront } from '../native/helper'

export async function getActiveApp(): Promise<ActiveAppInfo | null> {
  const front = await helperFront()
  if (!front) return null
  return {
    bundleId: front.bundleId,
    name: front.name,
    pid: front.pid,
    windowTitle: front.windowTitle,
    windowId: front.windowId,
    bounds: front.bounds
  }
}

export function isExcluded(app: ActiveAppInfo | null, excludedApps: string[]): boolean {
  if (!app) return false
  if (!app.bundleId) return false
  return excludedApps.includes(app.bundleId)
}