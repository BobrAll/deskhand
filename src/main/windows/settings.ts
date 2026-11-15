import { app, BrowserWindow } from 'electron'
import { denyExternalLinks } from '../denyExternalLinks'
import { loadPage } from '../pageLoad'
import { appWindowOptions } from './base'

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
/**
 * Cancels a close that is waiting for the renderer to finish a write.
 *
 * The window is hidden while it waits. Without this hook, opening settings again
 * during the grace would find the hidden window, show it, and then watch the old
 * close destroy it a moment later.
 */
let cancelPendingClose: (() => void) | null = null

/**
 * Set through the `settings.hold` channel while the renderer still has edits to
 * write; one word with the channel and with `DeskhandApi.settings.hold`.
 */
let settingsHeld = false

/**
 * Told when the settings window is gone.
 *
 * The renderer ends a hotkey recording from its unmount cleanup, which never runs
 * when the window is destroyed by the red button, ⌘W or a crash. The owner of
 * the global listeners registers here so those listeners are not left off.
 */
let settingsClosedHandler: (() => void) | null = null

export function setSettingsWindowClosedHandler(handler: () => void): void {
  settingsClosedHandler = handler
}

/**
 * Creates one of the standalone windows and shows it on its first paint.
 *
 * Only the fields a caller passes are set, so the settings window keeps its
 * minimum size and the onboarding window keeps `resizable: false`.
 *
 * Every app window gets the link guard here rather than at each caller: the
 * onboarding wizard renders the provider's key page as a link, and a window
 * created without the guard opens a chromeless child window on that site.
 */
function openAppWindow(options: AppWindowOptions): BrowserWindow {
  const win = new BrowserWindow({
    ...appWindowOptions(options.title, options.width, options.height),
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
  denyExternalLinks(win)
  loadPage(win, options.page)
  return win
}

/**
 * Holds the window open while the renderer still has edits to write.
 *
 * ⌘W and the red traffic light both come through the window's own `close`, not
 * through `settings:close`, so the grace period for an in-flight write has to
 * live on the window as well — otherwise the one gesture everybody uses to close
 * a window would be the one that loses the last keystroke.
 *
 * The `closing` latch is what lets the deferred `close()` through: without it the
 * second call would be held again, and the deadline would extend itself forever.
 */
function holdCloseUntilWritesLand(win: BrowserWindow): void {
  let closing = false
  let timer: ReturnType<typeof setTimeout> | null = null

  const cancelClose = (): void => {
    if (timer !== null) clearTimeout(timer)
    timer = null
    closing = false
    if (cancelPendingClose === cancelClose) cancelPendingClose = null
  }

  win.on('close', (event) => {
    if (closing || !settingsHeld) return
    event.preventDefault()
    closing = true
    // A window that is waiting for a write must not sit in front of the user and
    // flash back when another window activates the app. The renderer is still
    // alive while hidden; the write and the real close continue underneath.
    win.hide()
    cancelPendingClose = cancelClose
    // Polled rather than a fixed wait: a write usually lands in a few
    // milliseconds, and making the user watch a 1.2 s pause for it would be its
    // own small bug. The ceiling only exists so a wedged renderer cannot make the
    // window unclosable.
    const deadline = Date.now() + CLOSE_GRACE_MS
    const attempt = (): void => {
      timer = null
      if (win.isDestroyed()) return
      if (!settingsHeld || Date.now() >= deadline) {
        if (cancelPendingClose === cancelClose) cancelPendingClose = null
        win.close()
        return
      }
      timer = setTimeout(attempt, CLOSE_POLL_MS)
    }
    timer = setTimeout(attempt, CLOSE_POLL_MS)
  })

  win.on('closed', cancelClose)
}

export function openSettingsWindow(): BrowserWindow {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    // Reopening during the deferred close is a request to stay.
    cancelPendingClose?.()
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
  holdCloseUntilWritesLand(win)
  win.on('closed', () => {
    settingsWindow = null
    settingsHeld = false
    settingsClosedHandler?.()
  })
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
  closeIfOpen(onboardingWindow)
}

/**
 * Closes the settings window, letting any in-flight write land first.
 *
 * The waiting itself lives on the window's `close` handler, so every route to
 * closing — the «Закрыть» button, ⌘W, the red traffic light — goes through the
 * same grace period instead of only the one that happens to call this.
 */
export function closeSettingsWindow(): void {
  closeIfOpen(settingsWindow)
}

/** Closes one of the app windows if it is still there. */
function closeIfOpen(win: BrowserWindow | null): void {
  if (win && !win.isDestroyed()) win.close()
}

export function setSettingsHeld(held: boolean): void {
  settingsHeld = held
}

/**
 * The app windows that are open right now, for the activation handler.
 *
 * Closed singletons are dropped here rather than at every caller: the only
 * question anyone asks is "which window can be brought back", and a destroyed
 * window is not an answer.
 */
export function openAppWindows(): BrowserWindow[] {
  return [settingsWindow, onboardingWindow].filter((win): win is BrowserWindow => win !== null && !win.isDestroyed())
}

/**
 * Decides which of the app's windows may take the keyboard.
 *
 * The card takes focus as an ordinary window of this app, so macOS looks for the
 * next window of the app at the exact moment the card gives the keyboard up — on
 * Escape and when an agent run makes it click-through. A settings window the user
 * left behind another app is exactly that next window: it gets ordered in front
 * for the moment before focus reaches the remembered app, which looks like
 * settings flashing over the user's work. A window that cannot become key is not
 * a candidate, so the keyboard falls through to the app behind the card instead.
 * The caller parks the windows for that hand-off only and releases them right
 * after; keeping them parked for the whole session would make a visible settings
 * window ignore the user's click.
 */
export function setAppWindowsFocusable(focusable: boolean): void {
  for (const win of openAppWindows()) win.setFocusable(focusable)
}
