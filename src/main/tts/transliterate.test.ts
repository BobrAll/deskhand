import { describe, expect, it } from 'vitest'
import { transliterate, unknownWords } from './transliterate'

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
      .toBe('чек зэ пул рикв+ест он гитх+аб.')
    expect(transliterate('This is for you.')).toBe('зис из фор ю.')
  })

  it('reads pronouns as words, not as a known stem plus a plural', () => {
    expect(transliterate('his her them')).toBe('хиз хёр зем')
  })

  it('stresses compound names on the part a Russian speaker stresses', () => {
    expect(transliterate('JavaScript и TypeScript'))
      .toBe('джаваскр+ипт и тайпскр+ипт')
    expect(transliterate('Microsoft Electron'))
      .toBe('майкрос+офт электр+он')
  })

  it('spells acronyms letter by letter', () => {
    expect(transliterate('API')).toBe('эй пи ай')
    expect(transliterate('HTTPS')).toBe('эйч ти ти пи эс')
    expect(transliterate('JWT')).toBe('джей дабл ю ти')
    expect(transliterate('md')).toBe('эм ди')
  })

  it('reads an all-caps product name as a word, not as letters', () => {
    expect(transliterate('KAFKA')).toBe('кафка')
    expect(unknownWords('KAFKA')).toEqual(['kafka'])
    expect(unknownWords('JWT')).toEqual([])
  })

  it('recognises lowercase abbreviations that the letter rules would mangle', () => {
    expect(transliterate('api url id http html json'))
      .toBe('эй пи ай ю ар эл ай ди эйч ти ти пи эйч ти эм эл дж+ейсон')
  })

  it('carries the stress of a known word into its plural', () => {
    expect(transliterate('tokens updates caches services classes windows URLs'))
      .toBe('т+окенс апд+ейтс к+эшис с+ервисис классис у+индоуз ю ар элс')
  })

  it('does not put a space inside a word joined by an apostrophe', () => {
    expect(transliterate("don't user's")).toBe('донт +юзерс')
  })

  it('handles dotted file names and hyphens', () => {
    expect(transliterate('node.js')).toBe('н+оуд.джей эс')
    expect(transliterate('Wi-Fi')).toBe('в+ай фай')
    expect(transliterate('file.txt')).toBe('ф+айл.ти экс ти')
  })

  it('lists only the words the dictionary and rules cannot pronounce', () => {
    expect(unknownWords('Открой README и проверь localhost.')).toEqual(['localhost'])
    expect(unknownWords('Wi-Fi, tokens, URLs, API')).toEqual([])
    expect(unknownWords("don't user's")).toEqual(['don'])
    expect(unknownWords('нажми Escape')).toEqual([])
  })

  it('does not inflect a short function word as a noun', () => {
    expect(transliterate('uses')).toBe('усес')
    expect(unknownWords('uses')).toEqual(['uses'])
  })

  it('uses a model hint for a word the dictionary does not know', () => {
    expect(transliterate('localhost', { localhost: 'локалх+ост' })).toBe('локалх+ост')
    expect(transliterate('Открой localhost.', { localhost: 'локалх+ост' }))
      .toBe('Открой локалх+ост.')
  })

  it('falls back to rules for a word the dictionary does not know', () => {
    expect(transliterate('slurm')).toBe('слурм')
    expect(transliterate('cache')).toBe('к+эш')
  })

  it('leaves a Russian line untouched', () => {
    expect(transliterate('Проверь файл.')).toBe('Проверь файл.')
  })
})
