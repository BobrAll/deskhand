/**
 * Global hotkey management.
 *
 * The accelerator is user-configurable, so registration has to be able to replace
 * the previous binding and report failure (another app may own the combination).
 */

import { globalShortcut } from 'electron'

let current: string | null = null

export interface RegisterResult {
  ok: boolean
  accelerator: string
  message?: string
}

/** Registers `accelerator`, replacing whatever was registered before. */
export function registerHotkey(accelerator: string, handler: () => void): RegisterResult {
  const next = accelerator.trim()
  if (!next) return { ok: false, accelerator: next, message: 'Комбинация не задана.' }

  if (current === next && globalShortcut.isRegistered(next)) {
    return { ok: true, accelerator: next }
  }

  if (current) {
    globalShortcut.unregister(current)
    current = null
  }

  let ok = false
  try {
    ok = globalShortcut.register(next, handler)
  } catch {
    ok = false
  }

  if (!ok) {
    return {
      ok: false,
      accelerator: next,
      message: 'Комбинация занята другим приложением или недопустима.'
    }
  }

  current = next
  return { ok: true, accelerator: next }
}

export function unregisterHotkey(): void {
  if (current) {
    globalShortcut.unregister(current)
    current = null
  }
}

/** Checks whether an accelerator is available without keeping it claimed. */
export function canRegister(accelerator: string): boolean {
  const candidate = accelerator.trim()
  if (!candidate) return false
  if (candidate === current) return true
  if (globalShortcut.isRegistered(candidate)) return false
  let ok = false
  try {
    ok = globalShortcut.register(candidate, () => undefined)
  } catch {
    ok = false
  }
  if (ok) globalShortcut.unregister(candidate)
  return ok
}

export function currentHotkey(): string | null {
  return current
}