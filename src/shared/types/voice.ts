/** What a finished transcript does: ask the model, or type it into the app. */
export type VoiceAction = 'command' | 'dictate'

/** Hold-to-talk input: a local model turns speech into text. */
export interface VoiceSettings {
  enabled: boolean
  /** Accelerator held down to talk, e.g. "Control+Alt". */
  hotkey: string
  /**
   * Accelerator that always dictates into the frontmost app.
   *
   * Separate from `hotkey` because the two are different gestures: the main
   * combination follows `action`, while this one must never open a question on
   * the card — the words belong where the cursor is.
   */
  dictationHotkey: string
  /** Catalog ID or imported Whisper model filename. */
  model: string
  /** Whisper language code, or `auto` to let the model detect it. */
  language: string
  /** `command` sends the transcript to the model, `dictate` types it into the app. */
  action: VoiceAction
  /** `command` only: send the recognised wording at once instead of filling the field. */
  autoSend: boolean
  /**
   * What speaks the answer itself, as opposed to the short recorded lines.
   *
   * `off` — the answer is read, not heard; the card is the channel.
   * `system` — the macOS voice, free and local, but it reads like a log.
   * `neural` — the voice configured in `tts`, which costs a request per answer
   * and needs a key. Falls back to `system` when it is not configured.
   */
  answerVoice: AnswerVoice
  /** Short acknowledgement while an agent command is pending. */
  agentFeedback: boolean
  /** A shorter press is treated as an accidental tap and thrown away. */
  minDurationMs: number
  /** Hard cap so a stuck key cannot record forever. */
  maxDurationMs: number
}

export type AnswerVoice = 'off' | 'system' | 'neural'

/**
 * Where a line that was not recorded in advance is synthesised.
 *
 * `remote` is the OpenAI-compatible endpoint the user configures with a key.
 * `silero` is the Russian Silero V5.6 RU model, downloaded on demand. It runs
 * locally: the runtime is Python-based and is installed from the settings
 * window, not shipped inside the app.
 */
export type TtsEngine = 'remote' | 'silero'

/**
 * Live speech synthesis for lines that were not recorded in advance.
 *
 * The app ships with its short lines already rendered, so this is not needed for
 * the assistant to have a voice at all. It exists for two cases: reading an
 * answer aloud in the same voice, and re-recording a line in a different voice.
 *
 * Every field is the user's: the engine, the endpoint or local voice, and the
 * delivery instruction. Nothing here is baked into the build, and the key is not
 * part of this object at all — it lives encrypted in `secrets` and never reaches
 * a renderer.
 */
export interface TtsSettings {
  /** Off means "use the shipped recordings only". */
  enabled: boolean
  engine: TtsEngine
  /** `remote` only: API root without a trailing slash, e.g. `https://host/v1`. */
  baseUrl: string
  /** `remote` only: model id at that endpoint. */
  model: string
  /** `remote` only: voice name as the service spells it. */
  voice: string
  /** `remote` only: free-form delivery instruction, sent as `instructions`. */
  style: string
  /**
   * `silero` only: the speaker name.
   *
   * Kept apart from `voice` on purpose: both fields used to share one value, so
   * picking a Silero speaker rewrote the API voice in the next tab.
   */
  sileroVoice: string
  /**
   * `silero` only: ask the configured text model for words the seed dictionary
   * does not know, and cache the answer.
   *
   * Silero itself stays offline; this is the one optional request, and turning
   * it off leaves every unknown word to the transliteration rules and the stress
   * model.
   */
  pronunciationLookup: boolean
}

/** Lifecycle of one push-to-talk turn, mirrored into the overlay. */
export type VoicePhase = 'idle' | 'listening' | 'transcribing'

/** One turn of the voice pipeline: what the overlay needs to animate. */
/**
 * Why a voice turn ended without text.
 *
 * The card shows `error` as written, so the reason exists twice: once as a
 * sentence for the person reading it, and once as a code for the part that
 * decides whether to say something out loud. Matching on the sentence would
 * break the moment the wording changes.
 */
export type VoiceErrorCode = 'notHeard' | 'recordFailed' | 'transcribeFailed' | 'noMic' | 'recordTooLong'

export interface VoiceEvent {
  phase: VoicePhase
  /** 0..1 loudness of the last audio block; opens the bars on the chip. */
  level: number
  /** Set on `idle`: what happened, so the card can show it briefly. */
  text?: string
  /** Set on `idle` when the turn failed instead of producing text. */
  error?: string
  /** Set alongside `error`, so the reason does not have to be matched by text. */
  code?: VoiceErrorCode
}

/** Main -> the transparent field layer: draw or drop the voice strip. */
export interface FieldHighlightEvent {
  visible: boolean
  /** 0..1 microphone level, so the bars open with the user's voice. */
  level: number
}

export interface VoiceStatus {
  /** Everything needed for a turn is in place. */
  ready: boolean
  /**
   * Whether push-to-talk is switched on.
   *
   * `ready` only says the install is complete; a user who turned the feature off
   * still has the model and the binary. The overlay uses this to decide whether
   * opening the microphone ahead of a press is welcome at all.
   */
  enabled: boolean
  /** Human-readable reason when `ready` is false. */
  detail: string | null
  /** Model file that will actually be used, or null when none was found. */
  modelPath: string | null
  /**
   * The model that will actually transcribe: a catalog id, the file name of an
   * imported model, or null when nothing on disk matches.
   *
   * Not the same as `settings.voice.model`: that value can point at a model the
   * user never downloaded, and showing it as "selected" is what made a fresh
   * install claim a model it did not have.
   */
  activeModel: string | null
  /** Recognizer binary that will actually be used. */
  binaryPath: string | null
  /** Where models are downloaded to. */
  modelsDir: string
  /** Available bundled and downloaded catalog IDs, plus imported model filenames. */
  installed: string[]
  /** Set when the keyboard listener could not be started. */
  listenerError: string | null
}

export interface DownloadProgress {
  model: string
  received: number
  total: number
  done: boolean
  error?: string
}

/**
 * Whether the assistant can speak a line that was not recorded in advance.
 *
 * `configured: false` is not a broken app: the shipped lines still play, and an
 * answer is read with the macOS voice or not at all, depending on
 * `voice.answerVoice`.
 */
export interface TtsStatus {
  /** Live synthesis is switched on and has everything it needs. */
  configured: boolean
  /** Why not, when `configured` is false. */
  reason: string | null
  /** Which engine will speak. */
  engine: TtsEngine
  /** The voice that will speak live lines: the API voice or the Silero speaker. */
  voice: string
  model: string
  /** Whether an API key is stored for this endpoint. */
  keyConfigured: boolean
  /** The voice the shipped recordings were made with; always available. */
  recordedVoice: string
  /**
   * `silero` only: whether the local runtime and the model are on disk.
   *
   * The pane needs this to decide between "download it" and "it is ready" even
   * when synthesis is switched off; the reason alone is for the failure text.
   */
  silero: { installed: boolean } | null
}

/** One stage of the on-demand Silero installation, for the settings window. */
export interface TtsSetupProgress {
  /** `python` finds an interpreter, `runtime` installs the package, `models` downloads the weights. */
  stage: 'python' | 'runtime' | 'models'
  /** Bytes downloaded so far across all model files; zero for the first two stages. */
  received: number
  /** Total model bytes; zero for the first two stages. */
  total: number
  done: boolean
  error?: string
}

export interface TranscribeResult {
  ok: boolean
  text: string
  /** Wall-clock milliseconds spent in whisper, shown as "распознано за 0.9 с". */
  ms: number
  message?: string
  /**
   * True when the recognizer ran to completion and was not cancelled.
   *
   * The warm-up may treat a silent run as proof that the model loaded; a missing
   * binary, a model that never started, a failed temp-file write or a cancelled
   * run must not. An empty or unreadable transcript still counts as spawned,
   * because the model itself did run.
   */
  spawned?: boolean
}
