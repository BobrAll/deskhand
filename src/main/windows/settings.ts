import { app, BrowserWindow } from 'electron'
import { denyExternalLinks } from '../denyExternalLinks'
import { loadPage } from '../pageLoad'
import { baseOptions } from './base'

/** How long ⌘W waits for an in-flight settings write before it closes anyway. */
const CLOSE_GRACE_MS = 1200
/** Poll interval while waiting for that write. */
const CLOSE_POLL_MS = 80

interface AppWindowOptions {
  title: string
  width: number
  height: number
  page: string
  resizable?: boolean
  minWidth?: number
  minHeight?: number
}

let settingsWindow: BrowserWindow | null = null
let onboardingWindow: BrowserWindow | null = null

/** Set by `settings:hold` while the renderer still has edits to write. */
let settingsBusy = false

/**
 * Creates one of the standalone windows and shows it on its first paint.
 *
 * Only the fields a caller passes are set, so the settings window keeps its
 * minimum size and the onboarding window keeps `resizable: false`.
 */
function openAppWindow(options: AppWindowOptions): BrowserWindow {
  const win = new BrowserWindow({
    ...baseOptions(options.title, options.width, options.height),
    ...(options.resizable === undefined ? {} : { resizable: options.resizable }),
    ...(options.minWidth === undefined ? {} : { minWidth: options.minWidth }),
    ...(options.minHeight === undefined ? {} : { minHeight: options.minHeight })
  })
  win.once('ready-to-show', () => {
    win.show()
    try {
      app.focus({ steal: true })
    } catch {
      /* ignore */
    }
  })
  loadPage(win, options.page)
  return win
}

export function openSettingsWindow(): BrowserWindow {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.show()
    settingsWindow.focus()
    return settingsWindow
  }

  const win = openAppWindow({
    title: 'Deskhand — настройки',
    width: 980,
    height: 760,
    page: 'settings',
    minWidth: 820,
    minHeight: 560
  })
  settingsWindow = win
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
    const deadline = Date.now() + CLOSE_GRACE_MS
    const attempt = (): void => {
      if (win.isDestroyed()) return
      if (!settingsBusy || Date.now() >= deadline) {
        win.close()
        return
      }
      setTimeout(attempt, CLOSE_POLL_MS)
    }
    setTimeout(attempt, CLOSE_POLL_MS)
  })
  win.on('closed', () => {
    settingsWindow = null
    settingsBusy = false
  })
  denyExternalLinks(win)
  return win
}

export function openOnboardingWindow(): BrowserWindow {
  if (onboardingWindow && !onboardingWindow.isDestroyed()) {
    onboardingWindow.show()
    onboardingWindow.focus()
    return onboardingWindow
  }

  const win = openAppWindow({
    title: 'Deskhand',
    width: 760,
    height: 660,
    page: 'onboarding',
    resizable: false
  })
  onboardingWindow = win
  win.on('closed', () => {
    onboardingWindow = null
  })
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
