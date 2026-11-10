/**
 * The pre-recorded half of the assistant's voice.
 *
 * Lines that never depend on the answer are shipped as audio: they are played
 * from disk, so the first sound arrives with the same delay as a click and no
 * request is made at all. That is the whole reason the bank exists — a neural
 * voice that had to be generated on every acknowledgement would be slower than
 * the answer it is acknowledging.
 *
 * The mapping is by text, not by cue, on purpose: `automaticSpeech` stays the
 * single place that decides *what* is said, and a line that happens to match the
 * bank is simply spoken from a file. A line that does not match (an actual
 * answer) is either synthesised live — when the user configured a voice and
 * asked for it — or spoken by the macOS voice.
 *
 * `manifest.json` records the exact text each file was rendered from. Without it
 * a reworded line would keep playing the recording of the old wording — the
 * audio would say one thing and the card another. With it, a mismatch simply
 * means "no recording", and the line is synthesised instead.
 */
import { speechLines } from '@shared/speechBank'
import manifest from './speech/manifest.json'

const files = import.meta.glob('./speech/*.mp3', {
  eager: true,
  query: '?url',
  import: 'default'
}) as Record<string, string>

/**
 * Comparison form of a line.
 *
 * Case and trailing punctuation are not meaning: the model may answer "Готово"
 * where the bank recorded "Готово.", and both are the same sound. Anything
 * beyond that — a different word, an inserted clause — is a different line and
 * must not be swapped for a recording of another one.
 */
function key(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').replace(/[\s.!?…]+$/, '').trim()
}

const byText = new Map<string, string>()
for (const line of speechLines()) {
  const rendered = (manifest as Record<string, string>)[line.id]
  const url = files[`./speech/${line.id}.mp3`]
  // Both halves must agree: the file exists, and it was rendered from this text.
  if (url && rendered === line.text) byText.set(key(line.text), url)
}

/** The recorded clip for this exact line, or null when it must be synthesised. */
export function phraseAudio(text: string): string | null {
  return byText.get(key(text)) ?? null
}

/** How many lines actually shipped with audio; used by the tests and the docs. */
export function recordedLineCount(): number {
  return byText.size
}

/** Ids whose audio is missing or was rendered from different wording. */
export function staleLines(): string[] {
  return speechLines()
    .filter((line) => (manifest as Record<string, string>)[line.id] !== line.text ||
      !files[`./speech/${line.id}.mp3`])
    .map((line) => line.id)
}
