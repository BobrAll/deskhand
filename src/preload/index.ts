/**
 * Preload bridge. Exposes a narrow, typed API to the renderer bundles and nothing
 * else: no `ipcRenderer`, no Node APIs. contextIsolation stays on.
 */

import { contextBridge, ipcRenderer } from 'electron'
import { CH } from '../shared/ipc'
import type { SmartCursorApi, Unsubscribe } from '../shared/api'
import type {
  AgentAvailability,
  AgentCursorFrame,
  AgentEvent,
  AgentPointerFrame,
  AnnotationsEvent,
  AppSettings,
  ContextFlags,
  ContextSnapshot,
  DownloadProgress,
  OverlayState,
  PointerPayload,
  ProviderId,
  SendRequest,
  StreamEvent,
  TtsStatus,
  VoiceEvent
} from '../shared/types'
import type { TtsResult } from '../shared/tts'

function subscribe<T>(channel: string, handler: (payload: T) => void): Unsubscribe {
  const listener = (_event: Electron.IpcRendererEvent, payload: T): void => handler(payload)
  ipcRenderer.on(channel, listener)
  return () => {
    ipcRenderer.removeListener(channel, listener)
  }
}

const api: SmartCursorApi = {
  overlay: {
    getState: () => ipcRenderer.invoke(CH.overlay.getState) as Promise<OverlayState | null>,
    onState: (handler) => subscribe<OverlayState>(CH.overlay.state, handler),
    onPreparing: (handler) => subscribe<null>(CH.overlay.preparing, () => handler()),
    onContextUpdate: (handler) => subscribe<ContextSnapshot>(CH.overlay.contextUpdate, handler),
    onStream: (handler) => subscribe<StreamEvent>(CH.overlay.stream, handler),
    onAnnotations: (handler) => subscribe<AnnotationsEvent>(CH.overlay.annotations, handler),
    setFlags: (flags: ContextFlags) => ipcRenderer.send(CH.overlay.setFlags, flags),
    send: (request: SendRequest) => ipcRenderer.send(CH.overlay.send, request),
    cancel: (requestId: string) => ipcRenderer.send(CH.overlay.cancel, requestId),
    copy: (text: string) => ipcRenderer.invoke(CH.overlay.copy, text),
    paste: (text: string) => ipcRenderer.invoke(CH.overlay.paste, text),
    clearPointer: () => ipcRenderer.send(CH.overlay.clearPointer),
    setTyping: (typing: boolean) => ipcRenderer.send(CH.overlay.typing, typing),
    close: () => ipcRenderer.send(CH.overlay.close),
    resize: (height: number, width?: number, pin?: boolean) =>
      ipcRenderer.send(CH.overlay.resize, height, width, pin)
  },
  pointer: {
    onDraw: (handler) => subscribe<PointerPayload>(CH.pointer.draw, handler)
  },
  agent: {
    onEvent: (handler) => subscribe<AgentEvent>(CH.agent.event, handler),
    availability: () => ipcRenderer.invoke(CH.agent.availability) as Promise<AgentAvailability>,
    setEnabled: (enabled: boolean) =>
      ipcRenderer.invoke(CH.agent.setEnabled, enabled) as Promise<AgentAvailability>,
    stop: () => ipcRenderer.invoke(CH.agent.stop),
    answer: (id: string, allow: boolean, remember: boolean) =>
      ipcRenderer.invoke(CH.agent.answer, id, allow, remember),
    clearApprovals: () => ipcRenderer.invoke(CH.agent.clearApprovals)
  },
  agentCursor: {
    onState: (handler) => subscribe<AgentCursorFrame>(CH.agent.cursor, handler)
  },
  agentPresenter: {
    onState: (handler) => subscribe<AgentPointerFrame>(CH.agent.presentation, handler)
  },
  settings: {
    load: () => ipcRenderer.invoke(CH.settings.load),
    save: (settings: AppSettings) => ipcRenderer.invoke(CH.settings.save, settings),
    setKey: (provider: ProviderId, key: string) =>
      ipcRenderer.invoke(CH.settings.setKey, provider, key),
    deleteKey: (provider: ProviderId) => ipcRenderer.invoke(CH.settings.deleteKey, provider),
    testKey: (provider: ProviderId, key: string, baseUrl?: string) =>
      ipcRenderer.invoke(CH.settings.testKey, provider, key, baseUrl),
    runningApps: () => ipcRenderer.invoke(CH.settings.runningApps),
    pickApp: () => ipcRenderer.invoke(CH.settings.pickApp),
    open: () => ipcRenderer.send(CH.settings.open),
    close: () => ipcRenderer.send(CH.settings.close),
    hold: (busy: boolean) => ipcRenderer.send(CH.settings.hold, busy),
    recording: (active: boolean) => ipcRenderer.send(CH.settings.recording, active)
  },
  onboarding: {
    complete: () => ipcRenderer.invoke(CH.onboarding.complete),
    openSettings: () => ipcRenderer.send(CH.onboarding.openSettings)
  },
  permissions: {
    status: () => ipcRenderer.invoke(CH.permissions.status),
    request: () => ipcRenderer.invoke(CH.permissions.request),
    open: (kind) => ipcRenderer.send(CH.permissions.open, kind),
    requestMicrophone: () => ipcRenderer.invoke(CH.permissions.requestMicrophone)
  },
  voice: {
    onEvent: (handler) => subscribe<VoiceEvent>(CH.voice.event, handler),
    onRecord: (handler) => subscribe<{ maxDurationMs: number }>(CH.voice.record, handler),
    onStop: (handler) => subscribe<{ transcribe: boolean }>(CH.voice.stop, handler),
    attach: () => ipcRenderer.invoke(CH.voice.attach),
    recorded: (wavBase64: string, durationMs: number) =>
      ipcRenderer.invoke(CH.voice.recorded, wavBase64, durationMs),
    onTranscript: (handler) => subscribe<{ text: string; send: boolean }>(CH.voice.transcript, handler),
    failed: (message: string) => ipcRenderer.send(CH.voice.failed, message),
    level: (level: number) => ipcRenderer.send(CH.voice.level, level),
    status: () => ipcRenderer.invoke(CH.voice.status),
    download: (model: string) => ipcRenderer.invoke(CH.voice.download, model),
    onDownloadProgress: (handler) => subscribe<DownloadProgress>(CH.voice.downloadProgress, handler),
    importModel: () => ipcRenderer.invoke(CH.voice.importModel),
    deleteModel: (id) => ipcRenderer.invoke(CH.voice.deleteModel, id),
    test: () => ipcRenderer.invoke(CH.voice.test)
  },
  tts: {
    speak: (text: string) => ipcRenderer.invoke(CH.tts.speak, text) as Promise<TtsResult>,
    status: () => ipcRenderer.invoke(CH.tts.status) as Promise<TtsStatus>,
    setKey: (key: string) => ipcRenderer.invoke(CH.tts.setKey, key) as Promise<TtsStatus>,
    deleteKey: () => ipcRenderer.invoke(CH.tts.deleteKey) as Promise<TtsStatus>,
    preview: () => ipcRenderer.invoke(CH.tts.preview) as Promise<TtsResult>
  }
}

contextBridge.exposeInMainWorld('smartCursor', api)
