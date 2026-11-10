import { app, BrowserWindow } from 'electron'
import { denyExternalLinks } from '../denyExternalLinks'
import { loadPage } from '../pageLoad'
import { baseOptions } from './base'

let settingsWindow: BrowserWindow | null = null
let onboardingWindow: BrowserWindow | null = null

/** Set by `settings:hold` while the renderer still has edits to write. */
let settingsBusy = false

export function openSettingsWindow(): BrowserWindow {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.show()
    settingsWindow.focus()
    return settingsWindow
  }

  const win = new BrowserWindow({
    ...baseOptions('Deskhand — настройки', 980, 760),
    minWidth: 820,
    minHeight: 560
  })
  settingsWindow = win
  win.once('ready-to-show', () => {
    win.show()
    try {
      app.focus({ steal: true })
    } catch {
      /* ignore */
    }
  })
  /**
   * ⌘W and the red traffic light both come through here, not through
   * `settings:close`, so the grace period for an in-flight write has to live on
   * the window as well — otherwise the one gesture everybody uses to close a
   * window would be the one that loses the last keystroke.
   */
  let closing = false
  win.on('close', (event) => {
    if (closing || !settingsBusy) return
    event.preventDefault()
    closing = true
    // Polled rather than a fixed wait: a write usually lands in a few
    // milliseconds, and making the user watch a 1.2 s pause for it would be its
    // own small bug. The ceiling only exists so a wedged renderer cannot make the
    // window unclosable.
    const deadline = Date.now() + 1200
    const attempt = (): void => {
      if (win.isDestroyed()) return
      if (!settingsBusy || Date.now() >= deadline) {
        win.close()
        return
      }
      setTimeout(attempt, 80)
    }
    setTimeout(attempt, 80)
  })
  win.on('closed', () => {
    settingsWindow = null
    settingsBusy = false
  })
  denyExternalLinks(win)
  loadPage(win, 'settings')
  return win
}

export function openOnboardingWindow(): BrowserWindow {
  if (onboardingWindow && !onboardingWindow.isDestroyed()) {
    onboardingWindow.show()
    onboardingWindow.focus()
    return onboardingWindow
  }

  const win = new BrowserWindow({ ...baseOptions('Deskhand', 760, 660), resizable: false })
  onboardingWindow = win
  win.once('ready-to-show', () => {
    win.show()
    try {
      app.focus({ steal: true })
    } catch {
      /* ignore */
    }
  })
  win.on('closed', () => {
    onboardingWindow = null
  })
  loadPage(win, 'onboarding')
  return win
}

export function closeOnboardingWindow(): void {
  if (onboardingWindow && !onboardingWindow.isDestroyed()) onboardingWindow.close()
}

/**
 * Closes the settings window, letting any in-flight write land first.
 *
 * The waiting itself lives on the window's `close` handler, so every route to
 * closing — the «Закрыть» button, ⌘W, the red traffic light — goes through the
 * same grace period instead of only the one that happens to call this.
 */
export function closeSettingsWindow(): void {
  if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.close()
}

export function markSettingsBusy(busy: boolean): void {
  settingsBusy = busy
}

export function settingsWindows(): Array<BrowserWindow | null> {
  return [settingsWindow, onboardingWindow]
}
