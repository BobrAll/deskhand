/**
 * IPC wiring: the only bridge between the renderers and the main process.
 *
 * Renderers never touch the filesystem, the network or macOS APIs directly; every
 * capability is a named channel here, and secrets are never returned to a renderer
 * (ТЗ §7).
 */

import { execFile } from 'node:child_process'
import { dialog, ipcMain } from 'electron'
import { CH } from '@shared/ipc'
import { BUNDLED_VOICE_MODEL, PROVIDERS } from '@shared/defaults'
import type {
  AppSettings,
  ContextFlags,
  DownloadProgress,
  ProviderId,
  SendRequest
} from '@shared/types'
import type { ActionResult, AppPickResult, SettingsBundle } from '@shared/api'
import type { OverlayController } from './overlay'
import { applyHistorySettings } from './overlay/history'
import type { VoiceController } from './voice'
import { testApiKey } from './llm/testKey'
import { helperRunningApps, type RunningApp } from './native/helper'
import {
  openPermissionPane,
  readPermissions,
  requestMicrophonePermission,
  requestPermissions,
  type PermissionPane
} from './permissions'
import {
  deleteApiKey,
  deleteTtsKey,
  encryptionAvailable,
  keyStatuses,
  setApiKey,
  setTtsKey
} from './settings/secrets'
import { getSettings, patchSettings } from './settings/store'
import { ttsStatus, synthesize } from './tts'
import {
  closeOnboardingWindow,
  closeSettingsWindow,
  setSettingsHeld,
  openSettingsWindow
} from './windows'
import {
  deleteModel,
  downloadModel,
  importModel,
  voiceStatus
} from './voice/recognizer'

const PROVIDER_IDS: ProviderId[] = PROVIDERS.map((provider) => provider.id)

/** `defaults read` is a local call; a slow one means the app has no readable plist. */
const BUNDLE_ID_TIMEOUT_MS = 4000

/**
 * What the settings pane plays when the user asks to hear the voice.
 *
 * A fixed line, not user text: it has to be short enough to judge a voice by and
 * stable enough to be cached, and the pane has no business sending arbitrary
 * text to a service on a button press.
 */
const PREVIEW_LINE = 'Так, посмотрим. Сейчас разберусь и всё сделаю.'

function isProvider(value: unknown): value is ProviderId {
  return typeof value === 'string' && (PROVIDER_IDS as string[]).includes(value)
}

/**
 * Treats an incoming settings draft as a patch.
 *
 * A cast, not validation: the settings pane is the only writer and the store
 * normalises every field on the way in (`normalizeSettings`). Validating a
 * hostile renderer is a separate concern.
 */
function asSettingsPatch(raw: unknown): Partial<AppSettings> {
  if (typeof raw !== 'object' || raw === null) return {}
  return raw as Partial<AppSettings>
}

async function loadSettingsBundle(): Promise<SettingsBundle> {
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
    execFile('defaults', ['read', plist, 'CFBundleIdentifier'], { timeout: BUNDLE_ID_TIMEOUT_MS }, (error, stdout) => {
      if (error) resolve(null)
      else resolve(stdout.trim() || null)
    })
  })
}

async function pickApplication(): Promise<AppPickResult | null> {
  const result = await dialog.showOpenDialog({
    title: 'Выбери приложение',
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
  /** Re-registers the global hotkey; false means the combination is taken. */
  applyHotkey(accelerator: string): boolean
  applyLaunchAtLogin(enabled: boolean): void
  /** Silences (or restores) the global listeners while a hotkey is recorded. */
  setRecording(active: boolean): void
  quit(): void
}

/**
 * Applies the parts of a settings patch that live outside the store.
 *
 * Returns a bundle carrying `hotkeyError` when the new combination could not be
 * registered (the patch is rolled back first), and null when everything applied.
 */
async function applySettingsSideEffects(
  previous: AppSettings,
  next: AppSettings,
  deps: Pick<IpcDeps, 'applyHotkey' | 'applyLaunchAtLogin' | 'voice'>
): Promise<SettingsBundle | null> {
  if (next.rememberConversation !== previous.rememberConversation ||
    JSON.stringify(next.excludedApps) !== JSON.stringify(previous.excludedApps)) {
    applyHistorySettings(next.rememberConversation, next.excludedApps)
  }

  if (next.hotkey !== previous.hotkey) {
    const ok = deps.applyHotkey(next.hotkey)
    if (!ok) {
      // Roll back so the UI and the actual binding never disagree.
      patchSettings({ hotkey: previous.hotkey })
      deps.applyHotkey(previous.hotkey)
      return { ...(await loadSettingsBundle()), settings: getSettings(), hotkeyError: true }
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
  return null
}

export function registerIpc(deps: IpcDeps): void {
  /**
   * Points the voice settings at one model.
   *
   * One place, because three paths do it: a finished download, a finished
   * import, and a delete that took the selected model away. The model is read
   * from the settings at transcription time, so writing the file is enough —
   * unlike the hotkey, nothing holds it across calls.
   */
  function selectModel(id: string): void {
    patchSettings({ voice: { ...getSettings().voice, model: id } })
  }

  // ---- overlay -----------------------------------------------------------
  ipcMain.handle(CH.overlay.getState, () => deps.overlay.state())

  ipcMain.on(CH.overlay.send, (_event, request: SendRequest) => {
    void deps.overlay.send(request)
  })
  ipcMain.on(CH.overlay.cancel, (_event, requestId: string) => deps.overlay.cancel(requestId))
  ipcMain.on(CH.overlay.setFlags, (_event, flags: ContextFlags) => deps.overlay.setFlags(flags))
  ipcMain.on(CH.overlay.clearDrawing, () => deps.overlay.clearDrawing())
  ipcMain.on(CH.overlay.typing, (_event, typing: boolean) => deps.overlay.setTyping(Boolean(typing)))
  ipcMain.on(CH.overlay.resize, (_event, height: number, width?: number, pin?: boolean) =>
    deps.overlay.resize(height, width, Boolean(pin))
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
  ipcMain.handle(CH.settings.load, () => loadSettingsBundle())

  ipcMain.handle(CH.settings.save, async (_event, incoming: unknown) => {
    const previous = getSettings()
    const patch = asSettingsPatch(incoming)
    // Only the native dialog can add approvals. Settings drafts can be stale.
    if (patch.agent) patch.agent = { ...patch.agent, rememberedApprovals: previous.agent.rememberedApprovals }
    const next = patchSettings(patch)
    return (await applySettingsSideEffects(previous, next, deps)) ?? loadSettingsBundle()
  })

  ipcMain.handle(CH.settings.setKey, async (_event, provider: unknown, key: string) => {
    if (!isProvider(provider)) throw new Error('unknown-provider')
    setApiKey(provider, String(key ?? ''))
    return loadSettingsBundle()
  })

  ipcMain.handle(CH.settings.deleteKey, async (_event, provider: unknown) => {
    if (!isProvider(provider)) throw new Error('unknown-provider')
    deleteApiKey(provider)
    return loadSettingsBundle()
  })

  ipcMain.handle(CH.settings.testKey, (_event, provider: unknown, key: string, baseUrl?: string) => {
    if (!isProvider(provider)) return { ok: false, message: 'Неизвестный провайдер.' }
    return testApiKey(provider, String(key ?? ''), typeof baseUrl === 'string' ? baseUrl : undefined)
  })

  ipcMain.handle(CH.settings.runningApps, async (): Promise<RunningApp[]> => helperRunningApps())
  ipcMain.handle(CH.settings.pickApp, () => pickApplication())

  ipcMain.on(CH.settings.open, () => openSettingsWindow())
  ipcMain.on(CH.settings.close, () => closeSettingsWindow())
  // The renderer says "edits are still being written" before it asks to close and
  // clears the flag once the last write has landed. Without it, ⌘W during the
  // 450 ms debounce would destroy the window and take the edit with it.
  ipcMain.on(CH.settings.hold, (_event, held: boolean) => setSettingsHeld(Boolean(held)))
  ipcMain.on(CH.settings.recording, (_event, active: boolean) => deps.setRecording(Boolean(active)))

  // ---- permissions -------------------------------------------------------
  ipcMain.handle(CH.permissions.status, () => readPermissions())
  ipcMain.handle(CH.permissions.request, () => requestPermissions())
  ipcMain.handle(CH.permissions.requestMicrophone, () => requestMicrophonePermission())
  ipcMain.on(
    CH.permissions.open,
    (_event, kind: PermissionPane) => {
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
    return deps.voice.status()
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
      // Downloading a model is choosing it: asking for 500 MB and then having to
      // click the row again is a step that only exists because the two were
      // separate. Only a successful download selects — the catch below is a
      // failed one, and it must not change what is in use.
      selectModel(id)
    } catch {
      /* the failure is already in the last progress event */
    }
    return deps.voice.status()
  })

  ipcMain.handle(CH.voice.deleteModel, async (_event, model: string) => {
    const id = String(model ?? '')
    const wasSelected = getSettings().voice.model === id
    await deleteModel(id)
    if (wasSelected) selectModel(BUNDLED_VOICE_MODEL.id)
    return deps.voice.status()
  })

  ipcMain.handle(CH.voice.importModel, async () => {
    const picked = await dialog.showOpenDialog({
      title: 'Выбери модель whisper',
      properties: ['openFile'],
      filters: [{ name: 'Модель whisper', extensions: ['bin'] }]
    })
    if (picked.canceled || picked.filePaths.length === 0) return null
    try {
      selectModel(await importModel(picked.filePaths[0]))
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

  // ---- the assistant's voice ---------------------------------------------
  // Synthesis lives in the main process because that is where the key is: the
  // overlay asks for a line and gets a clip back, never a credential. The key
  // itself is written once and never read back through any channel.
  ipcMain.handle(CH.tts.speak, (_event, text: unknown, localOnly: unknown) =>
    synthesize(typeof text === 'string' ? text : '', localOnly === true)
  )
  ipcMain.handle(CH.tts.status, () => ttsStatus())
  ipcMain.handle(CH.tts.setKey, (_event, key: unknown) => {
    setTtsKey(typeof key === 'string' ? key : '')
    return ttsStatus()
  })
  ipcMain.handle(CH.tts.deleteKey, () => {
    deleteTtsKey()
    return ttsStatus()
  })
  ipcMain.handle(CH.tts.preview, () => synthesize(PREVIEW_LINE))

  // ---- agent (mouse and keyboard control) --------------------------------
  // The card can ask whether the assistant may press anything, can stop a run and
  // can answer the question the run is blocked on. It cannot start one: a run is
  // only ever started by a request the user typed, so no channel here moves the
  // cursor on its own.
  ipcMain.handle(CH.agent.availability, () => deps.overlay.agentAvailability())
  // Persisting the switch itself: it cannot start a run and it cannot move the
  // cursor — the settings tab and the card both use it, and nothing else does.
  ipcMain.handle(CH.agent.setEnabled, (_event, enabled: boolean) =>
    deps.overlay.setAgentEnabled(Boolean(enabled))
  )
  ipcMain.handle(CH.agent.clearApprovals, () => {
    patchSettings({ agent: { ...getSettings().agent, rememberedApprovals: [] } })
  })
  ipcMain.handle(CH.agent.stop, () => {
    deps.overlay.stopAgent()
  })
  // One answer to one question. The id is checked in the controller, so a stale
  // click — a button that was already handled, a second press after the run moved
  // on — is dropped instead of being applied to the next call.
  ipcMain.handle(CH.agent.answer, (_event, id: unknown, allow: unknown, remember: unknown) => {
    if (typeof id !== 'string' || !id) return
    deps.overlay.answerAgent(id, allow === true, remember === true)
  })
}
