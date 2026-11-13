/**
 * What the card says out loud: the text it reads, and the rules for how much of
 * an answer is worth speaking.
 */

import { SPEECH_BANK } from '@shared/speechBank'

/** A heading or a list item is a block of its own; the card shows them apart. */
const HEADING_MARKER = /^\s*#{1,6}\s+/
const BULLET_MARKER = /^\s*[-*+]\s+/
const NUMBERED_MARKER = /^\s*\d+[.)]\s+/
const QUOTE_MARKER = /^\s*>\s*/
/**
 * A horizontal rule is structure, not a sentence.
 *
 * The pattern mirrors `RULE` in `markdown.ts`, which is the canonical reader for
 * the card but does not export its line patterns.
 */
const RULE_MARKER = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/

/**
 * Punctuation that already gives the engine a place to pause.
 *
 * A full stop after any of these reads as a stutter, so a block ending like this
 * is joined to the next one by a space alone.
 */
const BLOCK_ALREADY_ENDS = /[.!?…:;,)—»]$/
/** Quotes and brackets a block can close with after its own punctuation. */
const CLOSING_MARKS = /["'»”’)\]}]+$/

function endsWithPause(block: string): boolean {
  return BLOCK_ALREADY_ENDS.test(block.replace(CLOSING_MARKS, ''))
}

/** What a line contributes to the spoken blocks. */
type LineKind = 'text' | 'heading' | 'item' | 'rule'

interface LineStart {
  kind: LineKind
  /** The line without its markers. A rule has no text worth reading. */
  text: string
}

/**
 * Peels the Markdown markers a line can start with.
 *
 * A quote is a wrapper around whatever follows, so `> - Пункт` and `> # Итог`
 * are a bullet and a heading, not quoted prose. Markers are peeled until none is
 * left, which is what makes `speechText` idempotent: its own output has no
 * markers for a second pass to remove.
 */
function lineStart(line: string): LineStart {
  let text = line
  let item = false
  for (;;) {
    const quote = text.match(QUOTE_MARKER)
    if (quote) {
      text = text.slice(quote[0].length)
      continue
    }
    if (RULE_MARKER.test(text)) return { kind: 'rule', text: '' }
    const heading = text.match(HEADING_MARKER)
    if (heading) return { kind: 'heading', text: text.slice(heading[0].length) }
    const bullet = text.match(BULLET_MARKER)
    if (bullet) {
      text = text.slice(bullet[0].length)
      item = true
      continue
    }
    if (NUMBERED_MARKER.test(text)) return { kind: 'item', text }
    return { kind: item ? 'item' : 'text', text }
  }
}

/**
 * Split Markdown into the blocks the card shows, one spoken sentence each.
 *
 * A block is a heading, a list item, or a paragraph. Lines without a marker keep
 * flowing into the open block, because Markdown wraps a long sentence by hand:
 * a line break there is layout, not a pause. A blank line, a marker or a rule
 * starts a new block. A numbered marker is kept as text — it is a number, not
 * decoration — and a rule is dropped because there is nothing to say about it.
 */
function speechBlocks(text: string): string[] {
  const blocks: string[] = []
  let continues = false
  for (const raw of text.split('\n')) {
    const start = lineStart(raw.trim())
    if (start.kind === 'rule') {
      continues = false
      continue
    }
    if (!start.text) {
      continues = false
      continue
    }
    if (start.kind === 'heading') {
      blocks.push(start.text)
      continues = false
      continue
    }
    if (start.kind === 'item' || !continues) blocks.push(start.text)
    else blocks[blocks.length - 1] += ` ${start.text}`
    continues = true
  }
  return blocks
}

/** Plain text for speech; never read executable instructions or markup aloud. */
export function speechText(text: string): string {
  const cleaned = text
    .replace(/```[\s\S]*?(?:```|$)/g, '')
    .replace(/^\s*@\w+.*$/gm, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/^\s*\|.*\|\s*$/gm, '')

  const blocks = speechBlocks(cleaned)
    .map(block => block.replace(/[*_`~]/g, '').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
  // Every block boundary is a pause: without punctuation the engine runs a list
  // or a heading into the next thought. The last block gets no closing full
  // stop — nothing follows it, so that would just be a stray separator.
  return blocks
    .map((block, index) =>
      index < blocks.length - 1 && !endsWithPause(block) ? `${block}.` : block
    )
    .join(' ')
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
