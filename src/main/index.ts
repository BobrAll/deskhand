/**
 * Application entry point.
 *
 * Order matters here: the app must be a tray-only accessory before any window
 * exists, permissions must be known before the first hotkey press, and the hotkey
 * must be registered only after `app.whenReady()`.
 */

import { app, Menu, nativeTheme } from 'electron'
import { createOverlayController } from './overlay'
import { createVoiceController } from './voice'
import { createGestureController } from './gesture'
import { registerHotkey, unregisterHotkey } from './hotkey'
import { registerIpc } from './ipc'
import { createTray, destroyTray, refreshTray } from './tray'
import { destroyPointer } from './pointer'
import { destroyAgentCursor } from './agent/cursor'
import { openOnboardingWindow, openSettingsWindow, overlayHost, showActiveWindow } from './windows'
import { getSettings, patchSettings } from './settings/store'
import { readPermissions } from './permissions'
import { encryptionAvailable } from './settings/secrets'

// Regular activation policy: the app behaves like a normal program — it has a
// Dock icon and a Cmd+Tab entry, and its windows can be focused, raised and sent
// to the background by the system like any other window. (Keeping the Dock icon
// hidden turned the app into a tray-only "accessory", whose windows macOS would
// hide the moment focus moved elsewhere.)

const overlay = createOverlayController(overlayHost)

/**
 * Push-to-talk. The controller needs the overlay (it opens the card and types the
 * transcript into it) and the overlay needs nothing from it, so the dependency
 * points one way.
 */
const voice = createVoiceController({
  prewarm: () => overlayHost.prewarm(),
  open: () => overlay.open(),
  isOpen: () => overlay.isOpen(),
  deliver: (text, send) => overlay.deliver(text, send),
  hide: () => overlay.close(),
  emit: (channel, payload) => overlay.emit(channel, payload),
  // The indicator is the card itself now (see `App.tsx`): the field is replaced
  // by the bars while a turn runs, so nothing is drawn at the cursor any more.
  setVoice: (active) => overlayHost.setVoice(active),
  target: () => overlay.target()
})

/**
 * Three-finger gestures. They are wired to the same two entry points the
 * keyboard uses — `overlay.open()` for the tap and the voice controller's own
 * press / release for the hold — so the two input paths can never drift apart.
 */
const gestures = createGestureController({
  open: () => overlay.open(),
  isOpen: () => overlay.isOpen(),
  press: () => voice.press(),
  release: () => voice.release(),
  cancel: () => voice.cancel()
})

function applyLaunchAtLogin(enabled: boolean): void {
  try {
    app.setLoginItemSettings({ openAtLogin: enabled, openAsHidden: true })
  } catch (error) {
    console.warn('[app] unable to change login item settings:', error)
  }
}

function applyHotkey(accelerator: string): boolean {
  const result = registerHotkey(accelerator, () => {
    void overlay.open()
  })
  if (!result.ok) {
    console.warn('[hotkey] registration failed:', result.message)
    return false
  }
  refreshTray()
  return true
}

function quit(): void {
  app.quit()
}

function bootstrap(): void {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: app.name,
        submenu: [
          { role: 'about', label: 'О Smart Cursor' },
          { type: 'separator' },
          { label: 'Настройки…', accelerator: 'CommandOrControl+,', click: () => openSettingsWindow() },
          { type: 'separator' },
          { role: 'hide', label: 'Скрыть' },
          { role: 'hideOthers', label: 'Скрыть остальные' },
          { type: 'separator' },
          { role: 'quit', label: 'Выйти из Smart Cursor' }
        ]
      },
      {
        label: 'Правка',
        submenu: [
          { role: 'undo', label: 'Отменить' },
          { role: 'redo', label: 'Повторить' },
          { type: 'separator' },
          { role: 'cut', label: 'Вырезать' },
          { role: 'copy', label: 'Копировать' },
          { role: 'paste', label: 'Вставить' },
          { role: 'selectAll', label: 'Выделить всё' }
        ]
      }
    ])
  )

  // IPC registration must happen before anything that can throw: without it the
  // settings window opens but every `invoke` rejects, so it stays empty forever.
  registerIpc({ overlay, voice, gestures, applyHotkey, applyLaunchAtLogin, quit })

  createTray({
    toggle: () => {
      void overlay.open()
    },
    openSettings: () => openSettingsWindow(),
    openOnboarding: () => openOnboardingWindow(),
    quit
  })

  const settings = getSettings()
  if (!applyHotkey(settings.hotkey)) {
    // Keep the app usable even if the stored accelerator is unavailable.
    if (settings.hotkey !== 'Alt+Space') applyHotkey('Alt+Space')
  }

  applyLaunchAtLogin(settings.launchAtLogin)

  // The tap has to be up before the first key press, so it is started with the
  // rest of the hotkeys rather than lazily on the first settings save.
  // `applySettings` also prewarms the overlay renderer when voice is enabled: the
  // microphone lives there, and a window created on the first press would lose
  // that press's animation and transcript.
  voice.applySettings()

  // The trackpad listener is a second helper process. It is started here rather
  // than lazily so the very first three-finger tap works, and it is additive: if
  // the machine has no trackpad it reports why and the keyboard paths are
  // untouched.
  gestures.applySettings()

  // The keyboard path needs the same warm renderer, and for the same reason: the
  // card is now put on screen before the context is collected, so the very first
  // Alt+Space must not land on a window that is still loading its page. Prewarming
  // is cheap — one hidden window, created off-screen and reused for every turn.
  overlayHost.prewarm()

  void readPermissions().then((permissions) => {
    if (!permissions.accessibility) {
      console.log('[permissions] accessibility is not granted yet — see the onboarding window')
    }
    if (!encryptionAvailable()) {
      console.warn('[secrets] safeStorage is unavailable; keys cannot be stored securely')
    }
  })

  // A manual launch (double-click on the app icon) must produce something visible:
  // the app is tray-only, so without this the click looks like a no-op. A launch
  // by the login item must stay quiet instead.
  let launchedManually = true
  try {
    launchedManually = !app.getLoginItemSettings().wasOpenedAtLogin
  } catch {
    // Older macOS builds may not report the flag at all; the visible overlay is
    // the safer default.
  }

  if (!settings.onboardingCompleted) {
    patchSettings({ onboardingCompleted: true })
    openOnboardingWindow()
  } else if (launchedManually) {
    void overlay.open()
  }
}

/** One instance only: a second launch just re-opens the overlay. */
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    void overlay.open()
  })

  app.whenReady().then(() => {
    nativeTheme.themeSource = 'system'
    // A failure while wiring the UI must not leave the process half-initialised:
    // the app is tray-only, so an unhandled throw here just leaves a dead icon.
    try {
      bootstrap()
    } catch (error) {
      console.error('[app] bootstrap failed:', error)
    }
  })

  app.on('activate', () => {
    // Coming back to the app (Dock click, Cmd+Tab) must bring an open window
    // forward instead of leaving an invisible one behind.
    showActiveWindow()
  })

  app.on('window-all-closed', () => {
    // Tray app: never quit just because a window closed.
  })

  app.on('will-quit', () => {
    unregisterHotkey()
    // The tap is a child process blocked in a run loop; without this it outlives
    // the app and keeps swallowing the shortcut.
    voice.stop()
    // Same reason as the keyboard tap: the helper blocks in a run loop and would
    // outlive the app, keeping the trackpad device open.
    gestures.stop()
    destroyTray()
    destroyPointer()
    destroyAgentCursor()
  })
}