/**
 * Where the voice may be cut and where a sentence may start.
 *
 * Both rules protect the same thing — a spoken sentence that is not interrupted
 * by the engine between two halves of a thought — and both used to be reachable
 * only through the whole speech hook with fake timers. The cases are the ones
 * that sound wrong when they break: a list number read as a sentence, a decimal
 * split in two, and a chunk cut that leaves the voice restarting its intonation.
 */

import { describe, expect, it } from 'vitest'
import { sentenceBoundary, speechChunks } from './speechChunks'

function chunks(text: string, limit: number): string[] {
  return [...speechChunks(text, limit)]
}

describe('speechChunks: cutting a long line', () => {
  it('keeps every chunk inside the limit', () => {
    const text = 'Короткое предложение. '.repeat(40)
    for (const chunk of chunks(text, 220)) {
      expect(chunk.length).toBeLessThanOrEqual(220)
    }
  })

  it('loses nothing but the whitespace at a cut', () => {
    const text = 'Первый абзац. '.repeat(30) + 'Последнее предложение.'
    const joined = chunks(text, 220).join(' ').replace(/\s+/g, ' ')
    expect(joined).toBe(text.replace(/\s+/g, ' '))
  })

  it('prefers a sentence end over a space', () => {
    const first = chunks('Короткое предложение. Продолжение без конца', 40)[0]
    expect(first.endsWith('.')).toBe(true)
  })

  it('falls back to a space when no sentence ends inside the window', () => {
    const first = chunks('Очень длинное предложение без точек и с пробелами', 20)[0]
    expect(first.length).toBeLessThanOrEqual(20)
    expect(first.endsWith(' ')).toBe(false)
    expect(first).not.toMatch(/[.!?…]$/)
  })

  it('cuts hard when there is no space either', () => {
    const line = 'а'.repeat(50)
    expect(chunks(line, 20)[0]).toBe('а'.repeat(20))
  })

  it('never leaves half of a surrogate pair at the cut', () => {
    // An emoji is two code units, so a limit that lands between them is a limit
    // that would produce two replacement characters.
    const line = 'а'.repeat(19) + '🙂' + 'б'.repeat(10)
    const first = chunks(line, 20)[0]
    expect(first.length).toBe(19)
    expect(first).toBe('а'.repeat(19))
  })
})

describe('sentenceBoundary: where a sentence really ends', () => {
  it('finds the last full stop', () => {
    expect(sentenceBoundary('Готово. Правда.')).toBe(14)
  })

  it('finds a question mark', () => {
    expect(sentenceBoundary('Готово! Правда?')).toBe(14)
  })

  it('does not cut a decimal in half', () => {
    expect(sentenceBoundary('Версия 2.5 готова')).toBe(-1)
  })

  it('does not read an ordered-list marker as a sentence', () => {
    expect(sentenceBoundary('1. Первый шаг')).toBe(-1)
    expect(sentenceBoundary('Шаг 2. Сделай')).toBe(-1)
  })

  it('has nothing to report in a line without punctuation', () => {
    expect(sentenceBoundary('Продолжение следует')).toBe(-1)
  })

  it('skips a list marker and finds the sentence after it', () => {
    expect(sentenceBoundary('1. Первый шаг. Второй.')).toBe(21)
  })
})
