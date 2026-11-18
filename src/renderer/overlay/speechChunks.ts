/**
 * Where a spoken line may be cut, and where it may start.
 *
 * The two questions belong together because they share the same hazard: a full
 * stop is not always the end of a sentence. `1. Первый шаг` opens a list, `2.5` is
 * one number, and a chunk boundary that lands in the middle of either of them is
 * heard as a stutter or as a bare "один." read out on its own.
 *
 * Both functions are pure and were inline in `useSpeech`: the rules could only be
 * checked by driving the whole hook with fake timers, which is why they now live
 * where a test can call them directly.
 */

/** The system voice is fed the answer in chunks of at most this many characters. */
export const SPEECH_CHUNK_CHARS = 220

/**
 * Splits a line into chunks no longer than `limit`.
 *
 * A boundary at a sentence end sounds like a pause; one at a space in the middle
 * of a sentence resets the intonation of a half-spoken thought. Only a split that
 * has neither falls back to the hard cut.
 */
export function* speechChunks(text: string, limit: number): Generator<string> {
  let remaining = text
  while (remaining.length > limit) {
    const window = remaining.slice(0, limit + 1)
    const sentence = Math.max(
      window.lastIndexOf('. '),
      window.lastIndexOf('! '),
      window.lastIndexOf('? '),
      window.lastIndexOf('… ')
    )
    let end = sentence > 0 ? sentence + 1 : window.lastIndexOf(' ')
    if (end < 1) {
      end = limit
      // Never cut a surrogate pair in half: the low half at the cut means the
      // character before it is its high half.
      const next = remaining.charCodeAt(end)
      if (next >= 0xdc00 && next <= 0xdfff) end--
    }
    yield remaining.slice(0, end)
    remaining = remaining.slice(end).trimStart()
  }
  if (remaining) yield remaining
}

/** `1.` / `2)` at the start of a block is a list marker, not a sentence end. */
const LIST_MARKER_AT_END = /(?:^|\s)\d{1,9}[.)]$/

/**
 * The last punctuation mark that really ends a sentence.
 *
 * `speechText` keeps an ordered-list number as text, so `1. Первый шаг` ends
 * with a full stop that is not a pause, and `2.5` is a decimal rather than two
 * sentences. A candidate at either of those places is skipped instead of
 * speaking a bare number or cutting a number in half.
 */
export function sentenceBoundary(text: string): number {
  for (let at = text.length - 1; at >= 0; at -= 1) {
    const char = text[at]
    if (char !== '.' && char !== '!' && char !== '?') continue
    if (char === '.' && isNotSentenceEnd(text, at)) continue
    return at
  }
  return -1
}

function isNotSentenceEnd(text: string, at: number): boolean {
  // Between digits: `2.5` is one number.
  if (/\d/.test(text[at - 1] ?? '') && /\d/.test(text[at + 1] ?? '')) return true
  // The end of a list marker: `1.` counts as number, not as a sentence.
  return LIST_MARKER_AT_END.test(text.slice(0, at + 1))
}
