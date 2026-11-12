import { describe, expect, it } from 'vitest'
import { transliterate } from './transliterate'

describe('transliterate', () => {
  it('writes a common word the way a Russian speaker says it', () => {
    expect(transliterate('README')).toBe('р+идми')
    expect(transliterate('file')).toBe('ф+айл')
    expect(transliterate('pull request')).toBe('пул рикв+ест')
  })

  it('keeps the Russian text and the punctuation in place', () => {
    expect(transliterate('Открой файл README и проверь pull request.'))
      .toBe('Открой файл р+идми и проверь пул рикв+ест.')
  })

  it('uses Russian readings for the common English function words', () => {
    expect(transliterate('Check the pull request on GitHub.'))
      .toBe('чек зэ пул рикв+ест он г+итхаб.')
    expect(transliterate('This is for you.')).toBe('зис из фор ю.')
  })

  it('spells acronyms letter by letter', () => {
    expect(transliterate('API')).toBe('эй пи ай')
    expect(transliterate('HTTPS')).toBe('эйч ти ти пи эс')
    expect(transliterate('md')).toBe('эм ди')
  })

  it('handles dotted file names and hyphens', () => {
    expect(transliterate('node.js')).toBe('ноуд.джей эс')
    expect(transliterate('Wi-Fi')).toBe('в+ай фай')
    expect(transliterate('file.txt')).toBe('ф+айл.ти экс ти')
  })

  it('falls back to rules for a word the dictionary does not know', () => {
    expect(transliterate('slurm')).toBe('слурм')
    expect(transliterate('cache')).toBe('к+эш')
  })

  it('leaves a Russian line untouched', () => {
    expect(transliterate('Проверь файл.')).toBe('Проверь файл.')
  })
})
