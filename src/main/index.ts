/**
 * Application entry point.
 *
 * Order matters here: the autoplay policy has to be set before any window
 * exists, permissions must be known before the first hotkey press, and the
 * hotkey must be registered only after `app.whenReady()`.
 */

import { app, Menu, nativeTheme } from 'electron'
import { createOverlayController } from './overlay'
import { createVoiceController } from './voice'
import { createRecordingMode } from './recording'
import { registerHotkey, unregisterHotkey } from './hotkey'
import { registerIpc } from './ipc'
import { createTray, destroyTray, refreshTray } from './tray'
import { destroyDrawing } from './drawing'
import { destroyAgentCursor } from './agent/cursor'
import { destroyAgentPresentation } from './agent/presentation'
import { flushTrace } from './agent/trace'
import {
  openOnboardingWindow,
  openSettingsWindow,
  overlayHost,
  setSettingsWindowClosedHandler,
  showActiveWindow
} from './windows'
import { getSettings, patchSettings } from './settings/store'
import { readPermissions } from './permissions'
import { encryptionAvailable } from './settings/secrets'
import { QUIT_LABEL, SETTINGS_ACCELERATOR, SETTINGS_LABEL } from './menus'
import { DEFAULT_SETTINGS } from '@shared/defaults'

/**
 * Audio has to start without a click.
 *
 * The card is opened by a global hotkey, and Chromium does not count that as a
 * user gesture: with the default policy every `Audio.play()` would be rejected
 * and the assistant would fall back to the system voice for no visible reason.
 * The window never loads remote content and plays only its own clips.
 */
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')

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
  showIndicator: () => overlay.showVoiceIndicator(),
  deliver: (text, options) => overlay.deliver(text, options),
  hide: () => overlay.close(),
  emit: (channel, payload) => overlay.emit(channel, payload),
  // The indicator is the card itself now (see `App.tsx`): the field is replaced
  // by the bars while a turn runs, so nothing is drawn at the cursor any more.
  setVoice: (active) => overlay.setVoice(active),
  target: () => overlay.target()
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

/**
 * Silences the app's own listeners while the settings window records a key.
 *
 * Without this, the combination being typed is intercepted before the recorder
 * sees it: the old binding is still registered globally, and the voice tap
 * swallows its own key, so re-assigning a shortcut to itself is impossible and
 * re-assigning it to another one fires the old action mid-recording.
 *
 * Restoring reads the settings store, so a combination the system refused is not
 * re-armed by accident.
 */
const setRecording = createRecordingMode({
  standDown: () => {
    unregisterHotkey()
    voice.suspend()
  },
  restore: () => {
    applyHotkey(getSettings().hotkey)
    voice.applySettings()
  }
})

function quit(): void {
  app.quit()
}

/**
 * Signals that ask the process to stop.
 *
 * Electron on macOS quits on SIGINT but ignores SIGTERM, and `electron-vite`
 * restarts the main process with `child.kill()`, which is SIGTERM. Without these
 * handlers the copy from before a rebuild survives, keeps the single-instance
 * lock, and the copy that was just started exits the moment it asks for the
 * lock. The dev server goes down with it, so every later `npm run dev` looks
 * like a crash right after "start electron app...".
 */
function handleSignal(signal: NodeJS.Signals): void {
  console.warn(`[app] received ${signal}; shutting down`)
  quit()
}

process.on('SIGTERM', handleSignal)
process.on('SIGINT', handleSignal)

/** The application menu: the same Settings and Quit entries the tray offers. */
function buildApplicationMenu(): void {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: app.name,
        submenu: [
          { role: 'about', label: 'О Deskhand' },
          { type: 'separator' },
          { label: SETTINGS_LABEL, accelerator: SETTINGS_ACCELERATOR, click: () => openSettingsWindow() },
          { type: 'separator' },
          { role: 'hide', label: 'Скрыть' },
          { role: 'hideOthers', label: 'Скрыть остальные' },
          { type: 'separator' },
          { role: 'quit', label: QUIT_LABEL }
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
}

/**
 * Logs what the first turn will be missing.
 *
 * Both facts are fixed in the onboarding window or the settings pane, so this
 * only records them; it opens nothing and changes nothing.
 */
function reportStartupPermissions(): void {
  void readPermissions().then((permissions) => {
    if (!permissions.accessibility) {
      console.log('[permissions] accessibility is not granted yet — see the onboarding window')
    }
    if (!encryptionAvailable()) {
      console.warn('[secrets] safeStorage is unavailable; keys cannot be stored securely')
    }
  })
}

/**
 * Whether `finishQuit` has started.
 *
 * Read by the deferred startup task: a quit that lands before it runs must not
 * create the tray after `destroyTray()` has just removed it.
 */
let quitStarted = false

function bootstrap(): void {
  buildApplicationMenu()

  // The renderer cannot end a recording when its window is destroyed, so the
  // window's own teardown does it. An explicit `false` that already arrived wins:
  // the switch ignores the repeat instead of registering the hotkey twice.
  setSettingsWindowClosedHandler(() => setRecording(false))

  // IPC registration must happen before anything that can throw: without it the
  // settings window opens but every `invoke` rejects, so it stays empty forever.
  registerIpc({
    overlay,
    voice,
    applyHotkey,
    applyLaunchAtLogin,
    setRecording,
    quit
  })

  // The renderer's page load is the longest part of showing the first card, and
  // everything below runs in the main process while that page is already loading
  // in its own renderer process. Creating the window first therefore overlaps the
  // two instead of adding one to the other: by the time the manual launch asks
  // for the card, the page is well past its first paint.
  //
  // The keyboard path needs this warm renderer: the card is now put on screen
  // before the context is collected, so the very first Alt+Space must not land on
  // a window that is still loading its page. It runs after `registerIpc` because
  // the page asks for its first state over IPC as soon as it mounts, and an
  // `invoke` with no handler rejects.
  try {
    overlayHost.prewarm()
  } catch (error) {
    // A window that cannot be created ahead of time is not fatal: the first
    // press creates one, only later.
    console.error('[app] overlay prewarm failed:', error)
  }

  const settings = getSettings()
  if (!applyHotkey(settings.hotkey)) {
    // Keep the app usable even if the stored accelerator is unavailable.
    if (settings.hotkey !== DEFAULT_SETTINGS.hotkey) applyHotkey(DEFAULT_SETTINGS.hotkey)
  }

  // The tap has to be up before the first key press, so it is started with the
  // rest of the hotkeys rather than lazily on the first settings save.
  // `applySettings` also prewarms the overlay renderer when voice is enabled: the
  // microphone lives there, and a window created on the first press would lose
  // that press's animation and transcript. The window is already up by now, so
  // this only confirms it.
  voice.applySettings()

  // A manual launch (double-click on the app icon) must produce something visible:
  // otherwise the click looks like a no-op. A launch by the login item must stay
  // quiet instead.
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

  // None of this is needed for the first window or the first hotkey, and creating
  // the tray alone blocks the main thread for tens of milliseconds. The zero
  // timeout moves it out of the synchronous part of `bootstrap` — it does not
  // wait for the card to paint, which happens in the renderer process anyway.
  // What it buys is that the hotkey, the voice tap and the window request are all
  // registered before the tray, the login item and a permission diagnostic take
  // the main thread.
  setTimeout(() => {
    // An immediate quit may have run `finishQuit` already; creating the tray
    // after `destroyTray()` would leave an icon nobody removes.
    if (quitStarted) return
    // Each step stands alone: a tray icon that cannot be created must not skip
    // the login item or the permission diagnostic as well.
    const attempt = (task: () => void): void => {
      try {
        task()
      } catch (error) {
        console.error('[app] deferred startup step failed:', error)
      }
    }
    attempt(() => createTray({
      openAssistant: () => {
        void overlay.open()
      },
      openSettings: () => openSettingsWindow(),
      openOnboarding: () => openOnboardingWindow(),
      quit
    }))
    attempt(() => applyLaunchAtLogin(settings.launchAtLogin))
    attempt(reportStartupPermissions)
  }, 0)
}

/** One instance only: a second launch just re-opens the overlay. */
if (!app.requestSingleInstanceLock()) {
  // The lock is what makes the second launch harmless, but it also means a copy
  // left over from an earlier run turns every new launch into an immediate exit
  // with no visible reason. Say which copy is in the way instead of vanishing.
  console.warn('[app] another copy is already running; this launch will exit')
  app.quit()
} else {
  // The only `second-instance` handler: `ipc.ts` used to register a second one
  // that called the same `open()`. It was invisible, because `open()` coalesces
  // an open that is already collecting, but it meant two places owned one
  // lifecycle event.
  app.on('second-instance', () => {
    void overlay.open()
  })

  app.whenReady().then(() => {
    nativeTheme.themeSource = 'system'
    // A failure while wiring the UI must not leave the process half-initialised:
    // the app has no main window to report it, so an unhandled throw here just
    // leaves a dead tray icon.
    try {
      bootstrap()
    } catch (error) {
      console.error('[app] bootstrap failed:', error)
    }
    // The agent's process is *not* started here. It is spawned on the first
    // action request and then kept alive, because a child that starts at launch
    // would hold a pipe and a run loop for a feature the user may never use, and
    // because the Accessibility grant it inherits is only meaningful at the
    // moment it acts.
  })

  app.on('activate', () => {
    // Coming back to the app (Dock click, Cmd+Tab) must bring an open window
    // forward instead of leaving an invisible one behind.
    showActiveWindow()
  })

  app.on('window-all-closed', () => {
    // Tray app: never quit just because a window closed.
  })

  let quitReady = false
  // Cleanup is best-effort and must never outlive its usefulness: a run that
  // never settles would otherwise hold the process, the single-instance lock
  // included, until someone kills it by hand.
  const QUIT_DEADLINE_MS = 5_000
  app.on('will-quit', (event) => {
    if (quitReady) return
    event.preventDefault()
    if (quitStarted) return
    quitStarted = true
    const deadline = new Promise<void>((resolve) => setTimeout(resolve, QUIT_DEADLINE_MS))
    void Promise.race([finishQuit(), deadline]).finally(() => {
      quitReady = true
      app.quit()
    })
  })

  async function finishQuit(): Promise<void> {
    unregisterHotkey()
    // The tap is a child process blocked in a run loop; without this it outlives
    // the app and keeps swallowing the shortcut.
    voice.stop()
    // The agent is a child process that blocks in a run loop; without this it
    // outlives the app and keeps a pipe open.
    await overlay.disposeAgent()
    // The trace queues its appends; a quit on the last event of a run would
    // otherwise drop the line that says how the run ended.
    await flushTrace()
    destroyTray()
    destroyDrawing()
    destroyAgentCursor()
    destroyAgentPresentation()
  }
}
