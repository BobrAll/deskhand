/**
 * IPC wiring: the only bridge between the renderers and the main process.
 *
 * Renderers never touch the filesystem, the network or macOS APIs directly; every
 * capability is a named channel here, and secrets are never returned to a renderer
 * (ТЗ §7).
 */

import { execFile } from 'node:child_process'
import { app, dialog, ipcMain } from 'electron'
import { CH } from '@shared/ipc'
import { PROVIDERS } from '@shared/defaults'
import type {
  AppSettings,
  ContextFlags,
  DownloadProgress,
  ProviderId,
  SendRequest
} from '@shared/types'
import type { ActionResult, AppPickResult, SettingsBundle } from '@shared/api'
import type { OverlayController } from './overlay'
import type { VoiceController } from './voice'
import type { GestureController } from './gesture'
import type { CursorHud } from './hud'
import { testApiKey } from './llm/testKey'
import { helperRunningApps, type RunningApp } from './native/helper'
import {
  openPermissionPane,
  readPermissions,
  requestMicrophonePermission,
  requestPermissions
} from './permissions'
import { deleteApiKey, encryptionAvailable, keyStatuses, setApiKey } from './settings/secrets'
import { getSettings, patchSettings } from './settings/store'
import {
  closeOnboardingWindow,
  closeSettingsWindowWhenSettled,
  markSettingsBusy,
  openSettingsWindow
} from './windows'
import { downloadModel, importModel, voiceStatus } from './voice/whisper'

const PROVIDER_IDS: ProviderId[] = ['openrouter', 'openai', 'anthropic']

function isProvider(value: unknown): value is ProviderId {
  return typeof value === 'string' && (PROVIDER_IDS as string[]).includes(value)
}

function sanitizeSettings(raw: unknown): Partial<AppSettings> {
  if (typeof raw !== 'object' || raw === null) return {}
  return raw as Partial<AppSettings>
}

async function bundle(): Promise<SettingsBundle> {
  return {
    settings: getSettings(),
    keys: keyStatuses(),
    permissions: await readPermissions(),
    encryptionAvailable: encryptionAvailable()
  }
}

/** Reads the bundle id out of an `.app` picked by the user. */
function readBundleId(appPath: string): Promise<string | null> {
  return new Promise((resolve) => {
    const plist = `${appPath}/Contents/Info`
    execFile('defaults', ['read', plist, 'CFBundleIdentifier'], { timeout: 4000 }, (error, stdout) => {
      if (error) resolve(null)
      else resolve(stdout.trim() || null)
    })
  })
}

async function pickApplication(): Promise<AppPickResult | null> {
  const result = await dialog.showOpenDialog({
    title: 'Выберите приложение',
    defaultPath: '/Applications',
    properties: ['openFile'],
    filters: [{ name: 'Приложения', extensions: ['app'] }]
  })
  if (result.canceled || result.filePaths.length === 0) return null
  const appPath = result.filePaths[0]
  const bundleId = await readBundleId(appPath)
  if (!bundleId) return null
  const name = appPath.split('/').pop()?.replace(/\.app$/, '') ?? bundleId
  return { bundleId, name }
}

export interface IpcDeps {
  overlay: OverlayController
  /** Push-to-talk: the keyboard tap and the whisper pipeline. */
  voice: VoiceController
  /** Three-finger trackpad gestures: tap opens the card, hold records. */
  gestures: GestureController
  /** The bubble at the cursor: asked for its last frame when its page mounts. */
  hud: CursorHud
  /** Re-registers the global hotkey; false means the combination is taken. */
  applyHotkey(accelerator: string): boolean
  applyLaunchAtLogin(enabled: boolean): void
  quit(): void
}

export function registerIpc(deps: IpcDeps): void {
  // ---- bubble -------------------------------------------------------------
  // Read-only: the bubble is a display and never reports anything back.
  ipcMain.handle(CH.hud.getState, () => deps.hud.getState())

  // ---- overlay -----------------------------------------------------------
  ipcMain.handle(CH.overlay.getState, () => deps.overlay.state())

  ipcMain.on(CH.overlay.send, (_event, request: SendRequest) => {
    void deps.overlay.send(request)
  })
  ipcMain.on(CH.overlay.cancel, (_event, requestId: string) => deps.overlay.cancel(requestId))
  ipcMain.on(CH.overlay.setFlags, (_event, flags: ContextFlags) => deps.overlay.setFlags(flags))
  ipcMain.on(CH.overlay.clearPointer, () => deps.overlay.clearPointer())
  ipcMain.on(CH.overlay.typing, (_event, typing: boolean) => deps.overlay.setTyping(Boolean(typing)))
  ipcMain.on(CH.overlay.resize, (_event, height: number, width?: number) =>
    deps.overlay.resize(height, width)
  )
  ipcMain.on(CH.overlay.close, () => deps.overlay.close())

  ipcMain.handle(CH.overlay.copy, async (_event, text: string): Promise<ActionResult> => {
    try {
      await deps.overlay.copy(text)
      return { ok: true }
    } catch {
      return { ok: false, message: 'Не удалось скопировать ответ.' }
    }
  })
  ipcMain.handle(CH.overlay.paste, (_event, text: string) => deps.overlay.paste(text))

  // ---- settings ----------------------------------------------------------
  ipcMain.handle(CH.settings.load, () => bundle())

  ipcMain.handle(CH.settings.save, async (_event, incoming: unknown) => {
    const previous = getSettings()
    const patch = sanitizeSettings(incoming)
    const next = patchSettings(patch)

    if (next.hotkey !== previous.hotkey) {
      const ok = deps.applyHotkey(next.hotkey)
      if (!ok) {
        // Roll back so the UI and the actual binding never disagree.
        patchSettings({ hotkey: previous.hotkey })
        deps.applyHotkey(previous.hotkey)
        return { ...(await bundle()), settings: getSettings(), hotkeyError: true }
      }
    }
    if (next.launchAtLogin !== previous.launchAtLogin) {
      deps.applyLaunchAtLogin(next.launchAtLogin)
    }
    // The voice hotkey is not a `globalShortcut`: it is a separate CGEventTap, so
    // it is restarted here instead of through `applyHotkey`.
    //
    // Only when the voice settings actually moved, though. The window now writes
    // on every pause in typing, and `applySettings` tears down and respawns the
    // helper process — restarting it for a keystroke in a system prompt would be
    // a worse bug than the one auto-apply fixed.
    if (JSON.stringify(next.voice) !== JSON.stringify(previous.voice)) {
      deps.voice.applySettings()
    }
    // Same reasoning for the trackpad listener: it is a child process whose
    // finger count and hold threshold are launch arguments, so only a real change
    // is worth restarting it for.
    if (JSON.stringify(next.gestures) !== JSON.stringify(previous.gestures)) {
      deps.gestures.applySettings()
    }
    return bundle()
  })

  ipcMain.handle(CH.settings.setKey, async (_event, provider: unknown, key: string) => {
    if (!isProvider(provider)) throw new Error('unknown-provider')
    setApiKey(provider, String(key ?? ''))
    return bundle()
  })

  ipcMain.handle(CH.settings.deleteKey, async (_event, provider: unknown) => {
    if (!isProvider(provider)) throw new Error('unknown-provider')
    deleteApiKey(provider)
    return bundle()
  })

  ipcMain.handle(CH.settings.testKey, (_event, provider: unknown, key: string, baseUrl?: string) => {
    if (!isProvider(provider)) return { ok: false, message: 'Неизвестный провайдер.' }
    return testApiKey(provider, String(key ?? ''), typeof baseUrl === 'string' ? baseUrl : undefined)
  })

  ipcMain.handle(CH.settings.runningApps, async (): Promise<RunningApp[]> => helperRunningApps())
  ipcMain.handle(CH.settings.pickApp, () => pickApplication())

  ipcMain.on(CH.settings.open, () => openSettingsWindow())
  ipcMain.on(CH.settings.close, () => closeSettingsWindowWhenSettled())
  // The renderer says "edits are still being written" before it asks to close and
  // clears the flag once the last write has landed. Without it, ⌘W during the
  // 450 ms debounce would destroy the window and take the edit with it.
  ipcMain.on(CH.settings.hold, (_event, busy: boolean) => markSettingsBusy(Boolean(busy)))

  // ---- permissions -------------------------------------------------------
  ipcMain.handle(CH.permissions.status, () => readPermissions())
  ipcMain.handle(CH.permissions.request, () => requestPermissions())
  ipcMain.handle(CH.permissions.requestMicrophone, () => requestMicrophonePermission())
  ipcMain.on(
    CH.permissions.open,
    (_event, kind: 'accessibility' | 'screenRecording' | 'microphone') => {
      openPermissionPane(kind)
    }
  )

  // ---- onboarding --------------------------------------------------------
  ipcMain.handle(CH.onboarding.complete, () => {
    patchSettings({ onboardingCompleted: true })
    closeOnboardingWindow()
  })
  ipcMain.on(CH.onboarding.openSettings, () => {
    closeOnboardingWindow()
    openSettingsWindow()
  })

  // ---- voice (push-to-talk) ----------------------------------------------
  ipcMain.handle(CH.voice.status, async () => {
    // The trackpad error rides along with the voice status: both describe "is the
    // voice path usable right now", and the settings tab shows them together.
    const status = await deps.voice.status()
    return { ...status, gestureError: deps.gestures.status().gestureError }
  })

  // The card is opened *by* the key press, so it asks what it missed on mount.
  ipcMain.handle(CH.voice.attach, () => deps.voice.attach())

  ipcMain.handle(CH.voice.recorded, async (_event, wavBase64: string, durationMs: number) => {
    return deps.voice.handleRecording({ wavBase64: String(wavBase64 ?? ''), durationMs: Number(durationMs) || 0 })
  })

  ipcMain.on(CH.voice.failed, (_event, message: string) => {
    deps.voice.failed(String(message ?? 'Микрофон недоступен.'))
  })

  ipcMain.on(CH.voice.level, (_event, level: number) => {
    deps.voice.setLevel(Number(level) || 0)
  })

  ipcMain.handle(CH.voice.download, async (event, model: string) => {
    const id = String(model ?? '')
    // Progress goes to the window that asked, not to every renderer: the overlay
    // has no business showing download bars.
    const report = (progress: DownloadProgress): void => {
      if (!event.sender.isDestroyed()) event.sender.send(CH.voice.downloadProgress, progress)
    }
    try {
      await downloadModel(id, report)
    } catch {
      /* the failure is already in the last progress event */
    }
    return deps.voice.status()
  })

  ipcMain.handle(CH.voice.importModel, async () => {
    const picked = await dialog.showOpenDialog({
      title: 'Выберите модель whisper',
      properties: ['openFile'],
      filters: [{ name: 'Модель whisper', extensions: ['bin'] }]
    })
    if (picked.canceled || picked.filePaths.length === 0) return null
    try {
      const id = await importModel(picked.filePaths[0])
      patchSettings({ voice: { ...getSettings().voice, model: id } })
      deps.voice.applySettings()
    } catch (error) {
      console.warn('[voice] import failed:', error)
    }
    return deps.voice.status()
  })

  ipcMain.handle(CH.voice.test, async () => {
    // A settings-window check has no microphone of its own, so the honest answer
    // is the install state — the real test is holding the hotkey.
    const status = await voiceStatus()
    return {
      ok: status.ready,
      text: status.ready ? '' : (status.detail ?? 'Голосовой ввод не готов.'),
      ms: 0,
      message: status.ready ? 'Можно удерживать горячую клавишу и говорить.' : (status.detail ?? undefined)
    }
  })

  // ---- agent (mouse and keyboard control) --------------------------------
  // The card can ask whether the assistant may press anything and can stop a run.
  // It cannot start one: a plan only ever comes from an answer that was already
  // streamed, so there is no channel here that moves the cursor on demand.
  ipcMain.handle(CH.agent.availability, () => deps.overlay.agentAvailability())
  // Persisting the switch itself: it cannot start a run and it cannot move the
  // cursor — the settings tab and the card both use it, and nothing else does.
  ipcMain.handle(CH.agent.setEnabled, (_event, enabled: boolean) =>
    deps.overlay.setAgentEnabled(Boolean(enabled))
  )
  ipcMain.handle(CH.agent.stop, () => {
    deps.overlay.stopAgent()
  })

  app.on('second-instance', () => {
    void deps.overlay.open()
  })

  // Referenced so the providers list stays part of the shared contract.
  void PROVIDERS
}