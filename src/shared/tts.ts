/**
 * The voice of the shipped recordings.
 *
 * These three values are not settings: they describe how the files in
 * `src/renderer/overlay/speech/` were made, the same way a photograph records
 * its camera. They are here so that a mismatch can be detected — a line whose
 * audio was rendered by a different engine or voice must not be played as if it
 * belonged to the configured one.
 *
 * Everything used at runtime comes from `AppSettings.tts`, and the key never
 * appears in this file or anywhere else in the build.
 */
export const RECORDED = {
  model: 'gemini-3.8-flash-tts:flow',
  voice: 'Kore',
  style: 'дружный'
} as const

/** Longest line worth synthesising; anything more is a document, not a reply. */
export const TTS_MAX_CHARS = 600

export type TtsResult =
  | { ok: true; audio: string; cached: boolean }
  /** `ok: false` is not an error the user must read: the caller falls back. */
  | { ok: false; message: string }
