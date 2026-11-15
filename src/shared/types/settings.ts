import type { TtsSettings, VoiceSettings } from './voice'
import type { AgentSettings } from './agent'

export type ProviderId = 'openrouter' | 'openai' | 'anthropic'

export interface AppSettings {
  provider: ProviderId
  /**
   * Per-provider model id, as the user typed it.
   *
   * There is no built-in default: empty means "not chosen yet", and a turn
   * refuses to start rather than guessing an id for someone else's account.
   */
  models: Record<ProviderId, string>
  /** Per-provider model override for background web search; empty uses `models`. */
  searchModels: Record<ProviderId, string>
  /**
   * Per-provider API base URL override (no trailing slash, no endpoint path).
   * Empty string means "use the provider default" — see `ProviderInfo.defaultBaseUrl`.
   */
  baseUrls: Record<ProviderId, string>
  /**
   * Per-provider JSON object merged into every model request body, as typed.
   * Lets a user pass what their gateway understands (e.g. a switch that turns
   * reasoning off) without the app knowing about that gateway. Empty = nothing.
   */
  extraBody: Record<ProviderId, string>
  temperature: number
  maxTokens: number
  systemPrompt: string
  /** Electron accelerator string, e.g. "Alt+Space". */
  hotkey: string
  captureScreenshotByDefault: boolean
  screenshotMaxSide: number
  screenshotQuality: number
  /** Bundle identifiers where Deskhand does nothing at all. */
  excludedApps: string[]
  rememberConversation: boolean
  launchAtLogin: boolean
  onboardingCompleted: boolean
  /** Push-to-talk voice input (local whisper). */
  voice: VoiceSettings
  /** Live synthesis for lines that were not recorded in advance. */
  tts: TtsSettings
  /** Mouse-and-keyboard control ("агент"). Off by default. */
  agent: AgentSettings
}

export interface ProviderInfo {
  id: ProviderId
  label: string
  /** Used when the user leaves the base URL field empty. */
  defaultBaseUrl: string
  keyUrl: string
}

export interface KeyStatus {
  provider: ProviderId
  configured: boolean
  encryptionAvailable: boolean
}

export type ModelListResult = { ok: true; models: string[] } | { ok: false; message: string }

/**
 * Where the settings window should land when another window asked for it.
 *
 * The card can tell the user "выбери модель в настройках", and the next thing it
 * does is open the window — at the top of whatever section it was left on. This
 * says which tab, which sub-view and which row the request was about, so the
 * settings window opens on the thing that needs attention.
 */
export interface SettingsTarget {
  tab?: 'provider' | 'voice' | 'agent' | 'privacy'
  /** A sub-view inside the tab, e.g. `models` in «Модель». */
  view?: 'connection' | 'models' | 'screenshot' | 'permissions' | 'data' | 'exceptions'
  /** A row to reveal and focus. */
  focus?: 'extraBody'
}

export interface TestKeyResult {
  ok: boolean
  message: string
}
