/**
 * What the card says out loud: the text it reads, and the rules for how much of
 * an answer is worth speaking.
 */

import { SPEECH_BANK } from '@shared/speechBank'

/** Plain text for speech; never read executable instructions or markup aloud. */
export function speechText(text: string): string {
  return text
    .replace(/```[\s\S]*?(?:```|$)/g, '')
    .replace(/^\s*@\w+.*$/gm, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/^\s*\|.*\|\s*$/gm, '')
    .replace(/^\s*(?:#{1,6}\s+|[-*+]\s+|>\s*)/gm, '')
    .replace(/[*_`~]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * What to say when the answer itself cannot be read aloud.
 *
 * It is a line from the recorded bank, so it is spoken instantly and in the
 * assistant's voice rather than the system one. Exported because the streaming
 * path has to recognise it: a placeholder must never be streamed as if it were
 * the answer's first sentence. The text comes from the bank itself, because the
 * recorded clip is matched against it word for word.
 */
export const ANSWER_FALLBACK = SPEECH_BANK.answerReady[0].text

/** Keep spoken failure messages short. */
const MAX_FAILURE_SENTENCES = 3
const MAX_FAILURE_CHARS = 420

/**
 * How often an acknowledgement may be spoken during one wait.
 *
 * The recorded lines are cheap but not free: repeating one every few seconds
 * turns a long wait into a monologue. The settings hint promises the same
 * interval in words («Не чаще раза в 45 секунд»), so the two must not drift.
 */
export const SPEECH_COOLDOWN_MS = 45_000

export function requestedReading(prompt: string): boolean {
  return /прочитай|зачитай|озвучь|вслух|read aloud/i.test(prompt)
}

export function automaticSpeech(prompt: string, answer: string, failed = false): string {
  const clean = speechText(answer)
  if (requestedReading(prompt)) return clean
  // Text creation and editing are reviewed visually. Media should start quietly.
  if (!failed && /напиши|перепиши|исправь|переведи|сократи|ответь на|напечатай|вставь|впиши|набери/i.test(prompt)) return ''
  if (!failed && /(?:включи|запусти|воспроизведи|открой).*(?:видео|музык|песн|ролик|подкаст)/i.test(prompt)) return ''
  if (!failed) return clean || (answer.trim() ? ANSWER_FALLBACK : '')
  const sentences = clean.match(/[^.!?]+(?:[.!?]+|$)/g) ?? []
  let result = ''
  for (const sentence of sentences.slice(0, MAX_FAILURE_SENTENCES)) {
    if ((result + sentence).length > MAX_FAILURE_CHARS) break
    result += sentence
  }
  // Don't cut a sentence into a misleading half-statement.
  if (!result.trim() && clean) return ANSWER_FALLBACK
  return result.trim()
}
