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

export type TtsResult =
  /** `mime` is what the clip actually is; the remote engine returns MP3, Piper WAV. */
  | { ok: true; audio: string; cached: boolean; mime: string }
  /** `ok: false` is not an error the user must read: the caller falls back. */
  | { ok: false; message: string }
