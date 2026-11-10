import type {
  AgentSettings,
  AnswerVoice,
  AppSettings,
  ProviderId,
  ProviderInfo,
  TtsSettings,
  VoiceSettings
} from './types'

export const DEFAULT_SYSTEM_PROMPT =
  'Ты ассистент в курсоре пользователя. Используй контекст активного приложения. ' +
  'Давай только результат, без вступлений и пояснений, на языке контекста, если пользователь ' +
  'не попросил иначе. Ответ на сообщение — готовый к отправке текст.'

/** Password managers and banking apps must never be sent anywhere. */
export const DEFAULT_EXCLUDED_APPS = [
  'com.1password.1password',
  'com.agilebits.onepassword7',
  'com.bitwarden.desktop',
  'com.dashlane.dashlane',
  'me.proton.pass.electron',
  'in.sinew.Enpass-Desktop',
  'com.apple.keychainaccess',
  'com.apple.Passwords'
]

export const PROVIDERS: ProviderInfo[] = [
  {
    id: 'openai',
    label: 'OpenAI',
    defaultBaseUrl: 'https://api.openai.com/v1',
    keyUrl: 'https://platform.openai.com/api-keys'
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    defaultBaseUrl: 'https://openrouter.ai/api/v1',
    keyUrl: 'https://openrouter.ai/keys'
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    defaultBaseUrl: 'https://api.anthropic.com/v1',
    keyUrl: 'https://console.anthropic.com/settings/keys'
  }
]

export function providerInfo(id: string): ProviderInfo | undefined {
  return PROVIDERS.find((provider) => provider.id === id)
}

type SearchModelDefaults = Pick<AppSettings, 'provider' | 'models' | 'baseUrls'>

/**
 * What web search uses when the user left the search field empty: the same model
 * they chose for chat. There is no built-in search model — a name shipped in the
 * build would be a guess about a provider account we cannot see.
 */
export function searchModelFallback(settings: SearchModelDefaults): string {
  return settings.models[settings.provider].trim()
}

export function resolveSearchModel(settings: SearchModelDefaults & Pick<AppSettings, 'searchModels'>): string {
  return settings.searchModels[settings.provider].trim() || searchModelFallback(settings)
}

/**
 * Cleans a user-supplied base URL: trims it, drops trailing slashes and any
 * copy-pasted endpoint path, so `.../v1` and `.../v1/` behave the same.
 * Returns an empty string for anything that is not a usable http(s) URL —
 * callers then fall back to the provider default.
 */
export function normalizeBaseUrl(input: unknown): string {
  if (typeof input !== 'string') return ''
  let value = input.trim()
  if (!value) return ''
  value = value.replace(/\/+$/, '')
  // Users often paste the full endpoint instead of the API root.
  value = value.replace(/\/(chat\/completions|messages|responses|audio\/speech|models|key)$/i, '')
  if (!/^https?:\/\/[^\s/]+/i.test(value)) return ''
  try {
    // Throws on things like "https://" with no host.
    void new URL(value)
  } catch {
    return ''
  }
  return value
}

/** The URL actually used for requests: the override when valid, else the default. */
export function resolveBaseUrl(provider: ProviderId, configured: string | undefined): string {
  return normalizeBaseUrl(configured) || providerInfo(provider)?.defaultBaseUrl || ''
}

export function isPlusVibeApi(baseUrl: string): boolean {
  if (!URL.canParse(baseUrl)) return false
  const { hostname } = new URL(baseUrl)
  return hostname === 'plusvibeapi.ru' || hostname === 'gw.plusvibeapi.ru' || hostname === 'plusvibeapi.com'
}

/**
 * The local whisper models the app can download. Sizes are the exact sizes of the
 * Hugging Face files, because the settings window shows them before a download
 * that may take minutes on a slow line.
 */
export interface WhisperModelMeta {
  id: string
  label: string
  /** File name inside the models directory. */
  file: string
  /** Download size in megabytes, rounded. */
  mb: number
  note: string
}

export const WHISPER_MODEL_BASE_URL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main'

export const WHISPER_MODELS: WhisperModelMeta[] = [
  {
    id: 'tiny',
    label: 'Tiny',
    file: 'ggml-tiny.bin',
    mb: 75,
    note: 'Мгновенно, но русский узнаёт плохо — только для проверки.'
  },
  {
    id: 'base',
    label: 'Base',
    file: 'ggml-base.bin',
    mb: 142,
    note: 'Быстро и небольшим весом. Годится для коротких команд.'
  },
  {
    id: 'small-q5_1',
    label: 'Small · q5_1',
    file: 'ggml-small-q5_1.bin',
    mb: 181,
    note: 'Лучший баланс: хороший русский, около секунды на фразу.'
  },
  {
    id: 'small',
    label: 'Small · f16',
    file: 'ggml-small.bin',
    mb: 466,
    note: 'Тот же Small без сжатия: чуть точнее, в 2.5 раза больше.'
  },
  {
    id: 'medium-q5_0',
    label: 'Medium · q5_0',
    file: 'ggml-medium-q5_0.bin',
    mb: 514,
    note: 'Заметно точнее на длинных фразах, но и медленнее.'
  },
  {
    id: 'large-v3-turbo-q5_0',
    label: 'Large v3 turbo · q5_0',
    file: 'ggml-large-v3-turbo-q5_0.bin',
    mb: 574,
    note: 'Максимальное качество. Нужен быстрый Mac и 8+ ГБ памяти.'
  }
]

/**
 * Lookup in `WHISPER_MODELS`, the whisper-only catalog.
 *
 * Production resolves a model through `voiceModel`, which also knows the
 * non-whisper engines; this lookup is used only by `defaults-guards.test.ts`, to
 * check that every catalog id resolves and an unknown id does not. Kept rather
 * than deleted because that is the invariant it guards.
 */
export function whisperModel(id: string): WhisperModelMeta | undefined {
  return WHISPER_MODELS.find((model) => model.id === id)
}

export interface VoiceModelMeta extends WhisperModelMeta {
  engine: 'whisper' | 'transcribe'
  url: string
  language?: string
  /**
   * The one the app points at when it has to choose for the user.
   *
   * It is a badge, not a filter: every model stays selectable, and the list is
   * ordered by size rather than by preference.
   */
  recommended?: boolean
}

const gigaamFile = 'gigaam-v3-e2e-rnnt-Q4_K_M.gguf'

export const VOICE_MODELS: VoiceModelMeta[] = [
  ...WHISPER_MODELS.map((model): VoiceModelMeta => ({
    ...model,
    engine: 'whisper',
    url: `${WHISPER_MODEL_BASE_URL}/${model.file}`
  })),
  {
    id: 'gigaam-v3-e2e-rnnt',
    label: 'GigaAM v3 E2E-RNNT · Q4_K_M',
    file: gigaamFile,
    mb: 184,
    note: 'Русская речь с пунктуацией и нормализацией чисел.',
    engine: 'transcribe',
    language: 'ru',
    recommended: true,
    url: `https://huggingface.co/handy-computer/gigaam-v3-e2e-rnnt-gguf/resolve/main/${gigaamFile}`
  }
]

export function voiceModel(id: string): VoiceModelMeta | undefined {
  return VOICE_MODELS.find((model) => model.id === id)
}

/** Key held to talk, language and what to do with the transcript. */
export const DEFAULT_VOICE: VoiceSettings = {
  enabled: true,
  // Separate from the main hotkey: the push-to-talk combination is swallowed by
  // the keyboard tap, so it must never be the same as the "type instead" one.
  hotkey: 'Alt+Shift+Space',
  model: 'small-q5_1',
  // `ru` rather than `auto`: detection on a three-word command is the most
  // common source of "он меня не понял" for a Russian-speaking user.
  language: 'ru',
  action: 'command',
  autoSend: true,
  // Off, deliberately. The card already shows the answer, so reading it aloud
  // duplicates what the user is looking at, and on a long answer the voice
  // becomes the slowest part of the turn. The hands-free case is real but
  // narrower than the "every voice question is spoken back" default suggests,
  // so it is opt-in. `system` is what the toggle turns on, because it always
  // works: no key, no network, no cost.
  answerVoice: 'off',
  agentFeedback: true,
  minDurationMs: 300,
  maxDurationMs: 120_000
}

/**
 * Live synthesis: off, and empty.
 *
 * Empty is not a placeholder for a default voice — there is none. A voice, an
 * endpoint and a key are the user's decision, and shipping a guess would spend
 * their credit on a service they never chose. The shipped recordings are what
 * makes the assistant audible without any of this.
 */
export const DEFAULT_TTS: TtsSettings = {
  enabled: false,
  baseUrl: '',
  model: '',
  voice: '',
  style: ''
}

export const WHISPER_LANGUAGES: Array<{ id: string; label: string }> = [
  { id: 'ru', label: 'Русский' },
  { id: 'auto', label: 'Определять автоматически' },
  { id: 'en', label: 'English' },
  { id: 'uk', label: 'Українська' },
  { id: 'kk', label: 'Қазақша' },
  { id: 'de', label: 'Deutsch' },
  { id: 'fr', label: 'Français' },
  { id: 'es', label: 'Español' },
  { id: 'it', label: 'Italiano' },
  { id: 'pt', label: 'Português' },
  { id: 'tr', label: 'Türkçe' },
  { id: 'zh', label: '中文' }
]

/**
 * Mouse-and-keyboard control. Off by default.
 *
 * What is *not* here is as deliberate as what is. There is no per-action delay:
 * the agent runs at its own pace and the user stops it with Escape or by taking
 * the mouse, which is a better brake than a sleep between clicks — a sleep is
 * paid on every run, while the brake is only paid when someone uses it. There is
 * also no "allow typing" or "allow shortcuts": those are the actions the mode
 * exists for, and the ones that need permission are asked about individually, at
 * the moment they happen, in the card.
 */
export const DEFAULT_AGENT: AgentSettings = {
  rememberedApprovals: [],
  enabled: false,
  // Multi-stage requests need room to navigate, search, open and observe. The
  // ceiling is the user's call; Escape and mouse interruption apply throughout.
  maxSteps: 100,
  abortOnMouseMove: true,
  // On by default: the whole point of the mode is that the user asked for the
  // thing to *happen*, and "готово" without a look at the result is a claim the
  // assistant cannot back up. It costs a tree diff, not a second model round
  // trip, so it is cheap enough to be the default.
  verifyResult: true,
  // Show what is happening: the target window comes forward and a pointer
  // travels to the element. This is presentation only — the same tools run when
  // it is off — and it is the switch a background mode will turn off.
  showActions: true
}

/**
 * The least output room an agent step is given, whatever `maxTokens` says.
 *
 * `maxTokens` was tuned for the writer, where an answer is a paragraph. An agent
 * step is a different shape: a sentence of reasoning wrapped around one tool call
 * whose arguments are nested JSON. At 1024 a step runs out mid-call, the
 * half-written call parses into no calls at all, and the loop sees an empty
 * reply — a run that did nothing and said nothing. A floor is a blunt instrument,
 * but the alternative is a silent failure that looks like the model refusing to
 * work.
 */
export const AGENT_MIN_OUTPUT_TOKENS = 4096

export const DEFAULT_SETTINGS: AppSettings = {
  provider: 'openai',
  models: {
    openrouter: '',
    openai: '',
    anthropic: ''
  },
  searchModels: { openrouter: '', openai: '', anthropic: '' },
  baseUrls: {
    openrouter: '',
    openai: '',
    anthropic: ''
  },
  extraBody: { openrouter: '', openai: '', anthropic: '' },
  temperature: 0.3,
  // Sized for the writer's answer, which is a paragraph. The agent is given more
  // than this on purpose — see AGENT_MIN_OUTPUT_TOKENS — because an agent step
  // is not a paragraph.
  maxTokens: 1024,
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
  hotkey: 'Alt+Space',
  captureScreenshotByDefault: true,
  screenshotMaxSide: 1600,
  screenshotQuality: 70,
  excludedApps: DEFAULT_EXCLUDED_APPS,
  rememberConversation: true,
  launchAtLogin: false,
  onboardingCompleted: false,
  voice: DEFAULT_VOICE,
  tts: DEFAULT_TTS,
  agent: DEFAULT_AGENT
}

/**
 * The range every numeric setting is kept inside.
 *
 * Two processes need the same numbers: `normalizeSettings` clamps what reaches
 * the store, and the settings pane offers the same range in its sliders and
 * number field. A second copy is how a slider ends up able to produce a value the
 * store then quietly replaces, so both sides read this object. The values are
 * inclusive; a step size is a property of the control, not of the setting, and
 * stays with the control.
 */
export const SETTINGS_BOUNDS = {
  screenshotMaxSide: { min: 480, max: 2400 },
  screenshotQuality: { min: 30, max: 95 },
  temperature: { min: 0, max: 2 },
  maxTokens: { min: 64, max: 8192 }
} as const

function clamp(value: unknown, min: number, max: number, fallback: number): number {
  const num = typeof value === 'number' && Number.isFinite(value) ? value : fallback
  return Math.min(max, Math.max(min, num))
}

function sanitizeStringList(input: unknown, fallback: string[]): string[] {
  if (!Array.isArray(input)) return fallback
  const list = input
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean)
  return Array.from(new Set(list))
}

function sanitizeVoice(input: unknown): VoiceSettings {
  const raw = (typeof input === 'object' && input !== null ? input : {}) as Partial<VoiceSettings> & { dialogue?: unknown }
  const model = voiceModel(String(raw.model ?? ''))?.id ?? DEFAULT_VOICE.model
  const language =
    typeof raw.language === 'string' && raw.language.trim()
      ? raw.language.trim().toLowerCase().slice(0, 8)
      : DEFAULT_VOICE.language
  return {
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : DEFAULT_VOICE.enabled,
    hotkey:
      typeof raw.hotkey === 'string' && raw.hotkey.trim()
        ? raw.hotkey.trim()
        : DEFAULT_VOICE.hotkey,
    model,
    language,
    action: raw.action === 'dictate' ? 'dictate' : 'command',
    answerVoice: sanitizeAnswerVoice(raw),
    agentFeedback: raw.agentFeedback !== false,
    autoSend: typeof raw.autoSend === 'boolean' ? raw.autoSend : DEFAULT_VOICE.autoSend,
    minDurationMs: Math.round(clamp(raw.minDurationMs, 0, 5_000, DEFAULT_VOICE.minDurationMs)),
    maxDurationMs: Math.round(
      clamp(raw.maxDurationMs, 1_000, 10 * 60_000, DEFAULT_VOICE.maxDurationMs)
    )
  }
}

/**
 * Which voice reads the answer, including the old boolean.
 *
 * `dialogue: true` was "speak the answer"; that is now `system`, because the
 * macOS voice is what it used to mean and it needs no configuration. An unknown
 * value falls back to off, never to a paid path.
 */
function sanitizeAnswerVoice(raw: { answerVoice?: unknown; dialogue?: unknown }): AnswerVoice {
  if (raw.answerVoice === 'system' || raw.answerVoice === 'neural' || raw.answerVoice === 'off') {
    return raw.answerVoice
  }
  return raw.dialogue === true ? 'system' : DEFAULT_VOICE.answerVoice
}

function sanitizeTts(input: unknown): TtsSettings {
  const raw = (typeof input === 'object' && input !== null ? input : {}) as Partial<TtsSettings>
  const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')
  return {
    enabled: raw.enabled === true,
    // A base URL is normalised the same way provider URLs are, so a pasted
    // `.../v1/audio/speech` becomes the root instead of a doubled path.
    baseUrl: normalizeBaseUrl(raw.baseUrl),
    model: text(raw.model).slice(0, 120),
    voice: text(raw.voice).slice(0, 60),
    style: text(raw.style).slice(0, 300)
  }
}

function sanitizeAgent(input: unknown): AgentSettings {
  const raw = (typeof input === 'object' && input !== null ? input : {}) as Partial<AgentSettings>
  const flag = (value: unknown, fallback: boolean): boolean =>
    typeof value === 'boolean' ? value : fallback
  return {
    rememberedApprovals: Array.isArray(raw.rememberedApprovals)
      ? [...new Set(raw.rememberedApprovals.filter(value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)))].slice(-256)
      : [],
    enabled: flag(raw.enabled, DEFAULT_AGENT.enabled),
    // Only the floor is enforced: a typo cannot produce a zero-step run, but the
    // user decides how large the budget is. The field is a text input, not a
    // preset, so an upper bound here would silently rewrite what they typed.
    maxSteps:
      typeof raw.maxSteps === 'number' && Number.isFinite(raw.maxSteps)
        ? Math.max(1, Math.round(raw.maxSteps))
        : DEFAULT_AGENT.maxSteps,
    abortOnMouseMove: flag(raw.abortOnMouseMove, DEFAULT_AGENT.abortOnMouseMove),
    verifyResult: flag(raw.verifyResult, DEFAULT_AGENT.verifyResult),
    showActions: flag(raw.showActions, DEFAULT_AGENT.showActions)
  }
}

/** Coerces anything coming from disk or IPC into a valid settings object. */
export function normalizeSettings(input: unknown): AppSettings {
  const raw = (typeof input === 'object' && input !== null ? input : {}) as Partial<AppSettings>
  const baseUrls = (
    typeof raw.baseUrls === 'object' && raw.baseUrls !== null ? raw.baseUrls : {}
  ) as Record<string, unknown>
  return {
    provider: PROVIDERS.some((provider) => provider.id === raw.provider)
      ? (raw.provider as ProviderId)
      : DEFAULT_SETTINGS.provider,
    models: normalizeModelIds(raw.models),
    searchModels: normalizeModelIds(raw.searchModels),
    baseUrls: {
      openrouter: normalizeBaseUrl(baseUrls.openrouter),
      openai: normalizeBaseUrl(baseUrls.openai),
      anthropic: normalizeBaseUrl(baseUrls.anthropic)
    },
    extraBody: normalizeExtraBody(raw.extraBody),
    temperature: clamp(
      raw.temperature,
      SETTINGS_BOUNDS.temperature.min,
      SETTINGS_BOUNDS.temperature.max,
      DEFAULT_SETTINGS.temperature
    ),
    maxTokens: Math.round(clamp(
      raw.maxTokens,
      SETTINGS_BOUNDS.maxTokens.min,
      SETTINGS_BOUNDS.maxTokens.max,
      DEFAULT_SETTINGS.maxTokens
    )),
    systemPrompt:
      typeof raw.systemPrompt === 'string' && raw.systemPrompt.trim()
        ? raw.systemPrompt
        : DEFAULT_SYSTEM_PROMPT,
    hotkey:
      typeof raw.hotkey === 'string' && raw.hotkey.trim() ? raw.hotkey.trim() : DEFAULT_SETTINGS.hotkey,
    captureScreenshotByDefault:
      typeof raw.captureScreenshotByDefault === 'boolean'
        ? raw.captureScreenshotByDefault
        : DEFAULT_SETTINGS.captureScreenshotByDefault,
    screenshotMaxSide: Math.round(clamp(
      raw.screenshotMaxSide,
      SETTINGS_BOUNDS.screenshotMaxSide.min,
      SETTINGS_BOUNDS.screenshotMaxSide.max,
      DEFAULT_SETTINGS.screenshotMaxSide
    )),
    screenshotQuality: Math.round(clamp(
      raw.screenshotQuality,
      SETTINGS_BOUNDS.screenshotQuality.min,
      SETTINGS_BOUNDS.screenshotQuality.max,
      DEFAULT_SETTINGS.screenshotQuality
    )),
    excludedApps: sanitizeStringList(raw.excludedApps, DEFAULT_EXCLUDED_APPS),
    rememberConversation: typeof raw.rememberConversation === 'boolean'
      ? raw.rememberConversation
      : DEFAULT_SETTINGS.rememberConversation,
    launchAtLogin:
      typeof raw.launchAtLogin === 'boolean' ? raw.launchAtLogin : DEFAULT_SETTINGS.launchAtLogin,
    onboardingCompleted:
      typeof raw.onboardingCompleted === 'boolean'
        ? raw.onboardingCompleted
        : DEFAULT_SETTINGS.onboardingCompleted,
    voice: sanitizeVoice(raw.voice),
    tts: sanitizeTts(raw.tts),
    agent: sanitizeAgent(raw.agent)
  }
}

function normalizeModelIds(input: unknown): Record<ProviderId, string> {
  const models = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>
  return {
    openrouter: typeof models.openrouter === 'string' ? models.openrouter.trim() : '',
    openai: typeof models.openai === 'string' ? models.openai.trim() : '',
    anthropic: typeof models.anthropic === 'string' ? models.anthropic.trim() : ''
  }
}

/** Kept as typed: the field is edited live, and reformatting it would move the caret. */
function normalizeExtraBody(input: unknown): Record<ProviderId, string> {
  const values = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>
  const pick = (value: unknown): string => (typeof value === 'string' ? value : '')
  return {
    openrouter: pick(values.openrouter),
    openai: pick(values.openai),
    anthropic: pick(values.anthropic)
  }
}

/** Fields the app writes itself; an extra body may not replace them. */
const RESERVED_BODY_FIELDS = new Set(['model', 'messages', 'stream', 'tools', 'system'])

/**
 * The user's extra request fields as an object, or `null` when the text is not
 * a JSON object. Empty text is an empty object. Reserved fields are dropped, so
 * a pasted example cannot replace the conversation or turn streaming off.
 */
export function parseExtraBody(text: string | undefined): Record<string, unknown> | null {
  const trimmed = (text ?? '').trim()
  if (!trimmed) return {}
  let value: unknown
  try {
    value = JSON.parse(trimmed)
  } catch {
    return null
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(([key]) => !RESERVED_BODY_FIELDS.has(key))
  )
}
