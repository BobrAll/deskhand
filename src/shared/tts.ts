/**
 * The voice of the shipped recordings.
 *
 * These three values are not settings: they describe how the files in
 * `src/renderer/overlay/speech/` were made, the same way a photograph records
 * its camera. Only `voice` is read — `main/tts/index.ts` copies it into
 * `TtsStatus.recordedVoice` so the settings window can name the voice the short
 * lines are in. Nothing compares the shipped clips against the configured
 * engine, so `model` and `style` record how they were rendered rather than
 * feeding a check.
 *
 * Everything used at runtime comes from `AppSettings.tts`, and the key never
 * appears in this file or anywhere else in the build.
 */
export const RECORDED = {
  model: 'gemini-3.8-flash-tts:flow',
  voice: 'Kore',
  style: 'дружный'
} as const

/** Maximum input length for one synthesis request. */
export const TTS_MAX_CHARS = 600

/**
 * The system voice, in the card and in the settings preview.
 *
 * Chromium can populate the voice list a frame or two after the first call, so
 * both places poll. They also share the reading pace, because the preview is
 * meant to sound like the card.
 */
export const SPEECH_VOICE_RETRY_MS = 200
export const SPEECH_VOICE_RETRIES = 10
/** Faster than the macOS default, which reads slower than a person scans the card. */
export const SPEECH_RATE = 1.3

/**
 * The voices of the optional Silero engine.
 *
 * Silero names its speakers in English, and the service takes those names as
 * they are — so the list stays in that spelling rather than inventing Russian
 * labels that would not match what the engine prints. `xenia` is the default
 * because it is the voice the model's own examples use.
 */
export const SILERO_SPEAKERS = ['xenia', 'kseniya', 'baya', 'aidar', 'eugene'] as const
export const SILERO_DEFAULT_SPEAKER = SILERO_SPEAKERS[0]

/** The speaker to ask for: the configured one when it is real, the default otherwise. */
export function sileroSpeaker(voice: string): string {
  return (SILERO_SPEAKERS as readonly string[]).includes(voice) ? voice : SILERO_DEFAULT_SPEAKER
}

/**
 * What the settings pane plays when the user asks to hear the voice.
 *
 * A fixed line, not user text: it has to be short enough to judge a voice by and
 * stable enough to be cached. It contains English terms because answers do, and
 * a voice that reads them badly is not the voice the user wants. The neural
 * engine and the macOS voice read the same sentence, so the two choices can be
 * compared on equal terms.
 */
export const PREVIEW_LINE = 'Так, посмотрим. Проверю README и pull request — сейчас разберусь.'

export type TtsResult =
  /** `mime` is what the clip actually is; the remote engine returns MP3, the local one a WAV. */
  | { ok: true; audio: string; cached: boolean; mime: string }
  /** `ok: false` is not an error the user must read: the caller falls back. */
  | { ok: false; message: string }
