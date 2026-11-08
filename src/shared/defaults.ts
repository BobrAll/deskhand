import type {
  AgentSettings,
  AppSettings,
  GestureSettings,
  ProviderId,
  ProviderInfo,
  QuickAction,
  VoiceSettings
} from './types'

export const DEFAULT_SYSTEM_PROMPT =
  'Ты ассистент, встроенный в курсор пользователя. Тебе дан контекст из активного приложения. ' +
  'Отвечай только результатом, без вступлений и пояснений, на том же языке, что и контекст, ' +
  'если пользователь не попросил иначе. Если просят написать ответ на сообщение, пиши готовый ' +
  'текст, который можно отправить как есть.'

export const DEFAULT_QUICK_ACTIONS: QuickAction[] = [
  {
    id: 'reply',
    label: 'Ответить',
    prompt: 'Напиши ответ на последнее сообщение в контексте. Готовый текст без пояснений.',
    mode: 'insert'
  },
  {
    id: 'summary',
    label: 'Саммари',
    prompt: 'Сделай краткое саммари содержимого: 3–5 пунктов, только суть.',
    mode: 'analyze'
  },
  {
    id: 'translate',
    label: 'Перевести',
    prompt: 'Переведи текст на английский язык. Верни только перевод.',
    mode: 'insert'
  },
  {
    id: 'fix',
    label: 'Исправить',
    prompt: 'Исправь орфографию, пунктуацию и стиль. Верни только исправленный текст.',
    mode: 'insert'
  },
  {
    id: 'explain',
    label: 'Объяснить',
    prompt: 'Объясни смысл содержимого простыми словами.',
    mode: 'analyze'
  }
]

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
    id: 'openrouter',
    label: 'OpenRouter',
    defaultModel: 'openai/gpt-4o-mini',
    defaultBaseUrl: 'https://openrouter.ai/api/v1',
    popularModels: [
      'openai/gpt-4o-mini',
      'openai/gpt-4o',
      'anthropic/claude-sonnet-4.5',
      'google/gemini-2.5-flash',
      'meta-llama/llama-3.2-11b-vision-instruct'
    ],
    supportsVision: true,
    keyUrl: 'https://openrouter.ai/keys'
  },
  {
    id: 'openai',
    label: 'OpenAI',
    defaultModel: 'gpt-4o-mini',
    defaultBaseUrl: 'https://api.openai.com/v1',
    popularModels: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini', 'gpt-4.1'],
    supportsVision: true,
    keyUrl: 'https://platform.openai.com/api-keys'
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    defaultModel: 'claude-sonnet-4-5',
    defaultBaseUrl: 'https://api.anthropic.com/v1',
    popularModels: [
      'claude-sonnet-4-5',
      'claude-opus-4-1',
      'claude-3-7-sonnet-latest',
      'claude-3-5-haiku-latest'
    ],
    supportsVision: true,
    keyUrl: 'https://console.anthropic.com/settings/keys'
  }
]

export function providerInfo(id: string): ProviderInfo | undefined {
  return PROVIDERS.find((provider) => provider.id === id)
}

export const OPENAI_DEFAULT_SEARCH_MODEL = 'gpt-5-search-api'

type SearchModelDefaults = Pick<AppSettings, 'provider' | 'models' | 'baseUrls'>

export function defaultSearchModel(settings: SearchModelDefaults): string {
  const { provider } = settings
  if (provider === 'openai' && !isPlusVibeApi(resolveBaseUrl(provider, settings.baseUrls[provider]))) {
    return OPENAI_DEFAULT_SEARCH_MODEL
  }
  return settings.models[provider].trim() || providerInfo(provider)?.defaultModel || ''
}

export function resolveSearchModel(settings: SearchModelDefaults & Pick<AppSettings, 'searchModels'>): string {
  return settings.searchModels[settings.provider].trim() || defaultSearchModel(settings)
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
  value = value.replace(/\/(chat\/completions|messages|responses|models|key)$/i, '')
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

export function whisperModel(id: string): WhisperModelMeta | undefined {
  return WHISPER_MODELS.find((model) => model.id === id)
}

export interface VoiceModelMeta extends WhisperModelMeta {
  engine: 'whisper' | 'transcribe'
  url: string
  language?: string
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
  dialogue: false,
  agentFeedback: true,
  minDurationMs: 300,
  maxDurationMs: 120_000
}

/**
 * Three fingers on the trackpad: a short touch opens the card, a longer one
 * records.
 *
 * `holdMs` sits above a firm tap and below "I am thinking about it": 450 ms is
 * long enough that a knock never records, and short enough that someone who does
 * intend to speak does not feel the microphone waiting. Gestures are additive —
 * every keyboard shortcut keeps working — so leaving them on by default cannot
 * take anything away.
 */
export const DEFAULT_GESTURES: GestureSettings = {
  enabled: true,
  fingers: 3,
  holdMs: 450
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
  // Multi-stage requests need room to navigate, search, open and observe. This
  // remains bounded, and Escape/mouse interruption applies throughout.
  maxSteps: 50,
  abortOnMouseMove: true,
  // On by default: the whole point of the mode is that the user asked for the
  // thing to *happen*, and "готово" without a look at the result is a claim the
  // assistant cannot back up. It costs a tree diff, not a second model round
  // trip, so it is cheap enough to be the default.
  verifyResult: true
}

export const DEFAULT_SETTINGS: AppSettings = {
  provider: 'openrouter',
  models: {
    openrouter: 'openai/gpt-4o-mini',
    openai: 'gpt-4o-mini',
    anthropic: 'claude-sonnet-4-5'
  },
  searchModels: { openrouter: '', openai: '', anthropic: '' },
  baseUrls: {
    openrouter: '',
    openai: '',
    anthropic: ''
  },
  temperature: 0.3,
  maxTokens: 1024,
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
  hotkey: 'Alt+Space',
  captureScreenshotByDefault: true,
  screenshotMaxSide: 1600,
  screenshotQuality: 70,
  quickActions: DEFAULT_QUICK_ACTIONS,
  excludedApps: DEFAULT_EXCLUDED_APPS,
  rememberConversation: true,
  launchAtLogin: false,
  onboardingCompleted: false,
  voice: DEFAULT_VOICE,
  gestures: DEFAULT_GESTURES,
  agent: DEFAULT_AGENT
}

const MIN_SIDE = 480
const MAX_SIDE = 2400

function clamp(value: unknown, min: number, max: number, fallback: number): number {
  const num = typeof value === 'number' && Number.isFinite(value) ? value : fallback
  return Math.min(max, Math.max(min, num))
}

function sanitizeQuickActions(input: unknown): QuickAction[] {
  if (!Array.isArray(input)) return DEFAULT_QUICK_ACTIONS
  const actions = input
    .filter((raw): raw is Partial<QuickAction> => typeof raw === 'object' && raw !== null)
    .map((raw, index) => ({
      id: typeof raw.id === 'string' && raw.id.trim() ? raw.id : `action-${index + 1}`,
      label: typeof raw.label === 'string' ? raw.label.slice(0, 40) : '',
      prompt: typeof raw.prompt === 'string' ? raw.prompt : '',
      mode: raw.mode === 'analyze' ? ('analyze' as const) : ('insert' as const)
    }))
    .filter((action) => action.label.trim() && action.prompt.trim())
  return actions.length > 0 ? actions : DEFAULT_QUICK_ACTIONS
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
  const raw = (typeof input === 'object' && input !== null ? input : {}) as Partial<VoiceSettings>
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
    dialogue: raw.dialogue === true,
    agentFeedback: raw.agentFeedback !== false,
    autoSend: typeof raw.autoSend === 'boolean' ? raw.autoSend : DEFAULT_VOICE.autoSend,
    minDurationMs: Math.round(clamp(raw.minDurationMs, 0, 5_000, DEFAULT_VOICE.minDurationMs)),
    maxDurationMs: Math.round(
      clamp(raw.maxDurationMs, 1_000, 10 * 60_000, DEFAULT_VOICE.maxDurationMs)
    )
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
    // The floor is 0 rather than a "sane" minimum: a user who wants no pause is
    // allowed to have none, but the slider cannot go below it by accident.
    maxSteps: Math.round(clamp(raw.maxSteps, 1, 50, DEFAULT_AGENT.maxSteps)),
    abortOnMouseMove: flag(raw.abortOnMouseMove, DEFAULT_AGENT.abortOnMouseMove),
    verifyResult: flag(raw.verifyResult, DEFAULT_AGENT.verifyResult)
  }
}

function sanitizeGestures(input: unknown): GestureSettings {
  const raw = (typeof input === 'object' && input !== null ? input : {}) as Partial<GestureSettings>
  return {
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : DEFAULT_GESTURES.enabled,
    // Two fingers are scroll and right-click territory, four belong to Mission
    // Control; three is the only count macOS leaves alone by default.
    fingers: 3,
    // Below 250 ms a knock becomes a recording; above 900 ms the card feels
    // stuck before it opens.
    holdMs: Math.round(clamp(raw.holdMs, 250, 900, DEFAULT_GESTURES.holdMs))
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
    temperature: clamp(raw.temperature, 0, 2, DEFAULT_SETTINGS.temperature),
    maxTokens: Math.round(clamp(raw.maxTokens, 64, 8192, DEFAULT_SETTINGS.maxTokens)),
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
    screenshotMaxSide: Math.round(
      clamp(raw.screenshotMaxSide, MIN_SIDE, MAX_SIDE, DEFAULT_SETTINGS.screenshotMaxSide)
    ),
    screenshotQuality: Math.round(clamp(raw.screenshotQuality, 30, 95, DEFAULT_SETTINGS.screenshotQuality)),
    quickActions: sanitizeQuickActions(raw.quickActions),
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
    gestures: sanitizeGestures(raw.gestures),
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

/** Models that are known to reject image input; used for the vision warning. */
export function modelSupportsVision(provider: ProviderId, model: string): boolean {
  const info = providerInfo(provider)
  if (!info) return false
  if (provider !== 'openrouter') return info.supportsVision
  const name = model.toLowerCase()
  const textOnly = ['o1-mini', 'o3-mini', 'deepseek', 'mistral-7b', 'llama-3.1-8b']
  return !textOnly.some((needle) => name.includes(needle))
}
