import type { ActiveAppInfo } from '@shared/types'

export type ObservedWindow = Pick<ActiveAppInfo, 'pid' | 'windowId' | 'windowTitle' | 'bounds'>

export function sameObservedWindow(a: ObservedWindow, b: ObservedWindow | null): boolean {
  if (!b || a.pid !== b.pid || a.windowId !== b.windowId || a.windowTitle !== b.windowTitle) return false
  if (!a.bounds || !b.bounds) return !a.bounds && !b.bounds
  return (
    a.bounds.x === b.bounds.x &&
    a.bounds.y === b.bounds.y &&
    a.bounds.width === b.bounds.width &&
    a.bounds.height === b.bounds.height
  )
}
