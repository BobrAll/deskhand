/**
 * Turns Latin words into the Cyrillic spelling Silero can actually say.
 *
 * Silero v5.6 has no Latin letters in its vocabulary: «README» is dropped
 * before the model sees it. The voice still sounds Russian, so the useful
 * substitute is not an English accent but the way a Russian speaker would read
 * the word — «ридми», «файл», «эй пи ай».
 *
 * Two layers:
 *
 * - The dictionary in `dictionary.ts`, for terms that appear in answers
 *   constantly. It also carries the stress mark (`+` before the vowel), because
 *   a neural stress model can guess wrong on a foreign word it has never seen.
 * - Rules for everything else. They are an approximation, not a phonetic
 *   transcription; an unknown word will sound Russian-accented, which is the
 *   point. The stress model runs after this and places the marks on words the
 *   dictionary did not cover.
 *
 * The result is only ever fed to synthesis. The card, the settings and the cache
 * keep the original text: the user must not see «р+идми» instead of «README».
 */

import { WORDS } from './dictionary'

/** Apostrophes and hyphens people type instead of the ASCII ones. */
const JOINERS = /['’-]/g

/** Every Latin word in a line: letters joined by an inner apostrophe or hyphen. */
const LATIN_WORD = /\p{Script=Latin}+(?:['’-]\p{Script=Latin}+)*/gu

/** The dictionary entry for a word, also trying it without its joiners. */
function dictionaryForm(word: string): string | undefined {
  return WORDS[word] ?? WORDS[word.replace(JOINERS, '')]
}

/** How a letter is pronounced when an acronym is spelled out. */
const LETTER_NAMES: Record<string, string> = {
  a: 'эй', b: 'би', c: 'си', d: 'ди', e: 'и', f: 'эф', g: 'джи',
  h: 'эйч', i: 'ай', j: 'джей', k: 'кей', l: 'эл', m: 'эм', n: 'эн',
  o: 'оу', p: 'пи', q: 'кью', r: 'ар', s: 'эс', t: 'ти', u: 'ю',
  v: 'ви', w: 'дабл ю', x: 'экс', y: 'уай', z: 'зед'
}

const LETTERS: Record<string, string> = {
  a: 'а', b: 'б', c: 'к', d: 'д', e: 'е', f: 'ф', g: 'г', h: 'х',
  i: 'и', j: 'дж', k: 'к', l: 'л', m: 'м', n: 'н', o: 'о', p: 'п',
  q: 'к', r: 'р', s: 'с', t: 'т', u: 'у', v: 'в', w: 'в', x: 'кс',
  y: 'и', z: 'з'
}

/** Long value of a vowel before a silent final `e`: `file` → файл. */
const LONG_VOWELS: Record<string, string> = { a: 'ей', e: 'и', i: 'ай', o: 'оу', u: 'ю' }

/** Longest first, so `tion` wins over `ti` and `sh`. */
const DIGRAPHS: Array<[string, string]> = [
  ['tion', 'шн'],
  ['sion', 'жн'],
  ['ture', 'чер'],
  ['eigh', 'ей'],
  ['ough', 'о'],
  ['igh', 'ай'],
  ['sh', 'ш'],
  ['ch', 'ч'],
  ['ph', 'ф'],
  ['th', 'т'],
  ['ck', 'к'],
  ['qu', 'кв'],
  ['wh', 'у'],
  ['gh', ''],
  ['oo', 'у'],
  ['ee', 'и'],
  ['ea', 'и'],
  ['ai', 'эй'],
  ['ay', 'эй'],
  ['ey', 'ей'],
  ['oa', 'оу'],
  ['ou', 'ау'],
  ['ow', 'оу'],
  ['oi', 'ой'],
  ['oy', 'ой'],
  ['ew', 'ью'],
  ['au', 'о'],
  ['aw', 'о'],
  ['ue', 'у'],
  ['ie', 'и'],
  ['ei', 'ей'],
  ['ng', 'нг']
]

/** Latin letters that decomposition does not split into a base letter and a mark. */
const FOLDED_LETTERS: Record<string, string> = {
  'ß': 'ss', 'æ': 'ae', 'œ': 'oe', 'ø': 'o', 'ł': 'l',
  'đ': 'd', 'ð': 'd', 'þ': 'th', 'ı': 'i'
}

/** One pattern for the same letters, so the map and the match cannot drift apart. */
const FOLDED_PATTERN = new RegExp(`[${Object.keys(FOLDED_LETTERS).join('')}]`, 'gi')

/**
 * A Latin word written with the base letters of its alphabet.
 *
 * Silero has no accented letter in its vocabulary, so `café` must reach the
 * letter rules as `cafe` instead of passing `é` through untouched.
 */
function foldLatin(word: string): string {
  return word
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(FOLDED_PATTERN, (letter) => FOLDED_LETTERS[letter.toLowerCase()])
}

/** The placeholder stands in for the long vowel produced by a silent final `e`. */
const LONG_MARK = '\u0001'
const SOFT_G = '\u0002'
const SOFT_C = '\u0003'

function spellAcronym(word: string): string {
  return [...word.toLowerCase()].map((letter) => LETTER_NAMES[letter] ?? letter).join(' ')
}

function looksLikeAcronym(word: string): boolean {
  // A vowel-less capitalised token is an abbreviation (`JWT`, `HTML`, `SQL`).
  // A capitalised product name with vowels (`KAFKA`, `REDIS`) is a word and
  // must reach the rules or the pronunciation hint, not the letter names.
  if (/^[A-Z]{2,6}$/.test(word)) return !/[AEIOU]/.test(word)
  // A lowercase short token with no vowel is an abbreviation too: `md`, `pkg`.
  return word.length >= 2 && word.length <= 3 && !/[aeiouy]/i.test(word)
}

/**
 * The marker for a `g` or `c` that the letter rules must read soft, and the
 * letter itself for everything else.
 */
function softConsonant(letter: string): string {
  if (letter === 'g') return SOFT_G
  if (letter === 'c') return SOFT_C
  return letter
}

/**
 * Applies a silent final `e` to the word the letter rules are about to read.
 *
 * `file` becomes a long `i` and a plain `l`; `slice` a long `i` and a soft `c`;
 * `table` only loses the `e`, because it does not lengthen the vowel before it.
 * The markers in the returned text are what `ruleTransliterate` understands.
 */
function applyFinalE(word: string): { marked: string; longVowel: string } {
  const magic = /^(.*?)([aeiou])([^aeiou])e$/.exec(word)
  if (magic) {
    return { marked: `${magic[1]}${LONG_MARK}${softConsonant(magic[3])}`, longVowel: magic[2] }
  }
  if (word.length > 2 && word.endsWith('e') && !/[aeiou]$/.test(word.slice(0, -1))) {
    // The `e` is silent, but a `g` or `c` before it is still soft: `edge` must
    // not become «едг» and `large` not «ларг».
    const head = word.slice(0, -2)
    return { marked: `${head}${softConsonant(word[word.length - 2])}`, longVowel: '' }
  }
  return { marked: word, longVowel: '' }
}

function ruleTransliterate(input: string): string {
  const { marked: word, longVowel } = applyFinalE(input.toLowerCase())

  let out = ''
  for (let index = 0; index < word.length; ) {
    const char = word[index]
    if (char === LONG_MARK) {
      out += LONG_VOWELS[longVowel] ?? 'е'
      index += 1
      continue
    }
    if (char === SOFT_G) {
      out += 'дж'
      index += 1
      continue
    }
    if (char === SOFT_C) {
      out += 'с'
      index += 1
      continue
    }

    const pair = word.slice(index, index + 2)
    if (index === 0 && (pair === 'kn' || pair === 'wr')) {
      out += pair === 'kn' ? 'н' : 'р'
      index += 2
      continue
    }
    const digraph = DIGRAPHS.find(([pattern]) => word.startsWith(pattern, index))
    if (digraph) {
      out += digraph[1]
      index += digraph[0].length
      continue
    }
    if (char === 'c') {
      out += /[eiy]/.test(word[index + 1] ?? '') ? 'с' : 'к'
    } else if (char === 'g') {
      out += /[eiy]/.test(word[index + 1] ?? '') ? 'дж' : 'г'
    } else if (char === 'y') {
      out += index === 0 && /[aeiou]/.test(word[index + 1] ?? '') ? 'й' : 'и'
    } else {
      out += LETTERS[char] ?? char
    }
    index += 1
  }
  return out
}

/**
 * A known singular with an English plural ending.
 *
 * The rules lose the stem's stress mark and read a silent `e` as a vowel, so
 * `updates` becomes «упдатес» instead of «апд+ейтс». Reusing the dictionary form
 * keeps both the sound and the stress of the word the user already knows.
 */
function pluralOf(word: string): string | null {
  if (!word.endsWith('s')) return null
  const stems = word.endsWith('es')
    ? [word.slice(0, -1), word.slice(0, -2)]
    : [word.slice(0, -1)]
  for (const stem of stems) {
    // A two-letter stem is a function word (`us`, `it`), not a noun that takes
    // an English plural; `uses` must not become «асис».
    if (stem.length < 3) continue
    const singular = dictionaryForm(stem)
    if (!singular) continue
    const last = singular[singular.length - 1]
    // A russified word ending in `а`/`е`/`я` adds the English plural differently
    // (`фича` + `с` is not `features`); let the letter rules handle those.
    if ('аеёяэ'.includes(last)) continue
    if ('шжчщсзц'.includes(last)) return `${singular}ис`
    if (last === 'ь') return `${singular.slice(0, -1)}с`
    return `${singular}с`
  }
  return null
}

function acronymPluralOf(word: string): string | null {
  const match = /^([A-Z]{2,6})s$/.exec(word)
  if (!match) return null
  const stem = match[1]
  const lower = stem.toLowerCase()
  const known = WORDS[lower]
  if (known && known.includes(' ')) return `${known}с`
  return looksLikeAcronym(stem) ? `${spellAcronym(stem)}с` : null
}

/** Whether the dictionary, the plural rule or the acronym rules can say this word. */
function needsPronunciation(word: string): boolean {
  const lower = word.toLowerCase()
  if (dictionaryForm(lower)) return false
  if (acronymPluralOf(word)) return false
  if (pluralOf(lower)) return false
  return !looksLikeAcronym(word)
}

/**
 * Latin words that need a pronunciation hint, without duplicates.
 *
 * The whole token is checked first so «Wi-Fi» stays in the dictionary instead of
 * being split into two unknown words. A token that is not known is split at its
 * hyphens and apostrophes, exactly as `transliterate` will split it.
 */
export function unknownWords(text: string): string[] {
  const words = new Set<string>()
  for (const token of text.match(LATIN_WORD) ?? []) {
    const folded = foldLatin(token)
    if (dictionaryForm(folded.toLowerCase())) continue
    for (const part of folded.split(/['’-]/).filter(Boolean)) {
      if (part.length < 2) continue
      if (needsPronunciation(part)) words.add(part.toLowerCase())
    }
  }
  return [...words]
}

function transliterateWord(word: string, pronunciations: Readonly<Record<string, string>>): string {
  const folded = foldLatin(word)
  const lower = folded.toLowerCase()
  const known = dictionaryForm(lower)
  if (known) return known
  const acronymPlural = acronymPluralOf(folded)
  if (acronymPlural) return acronymPlural
  const plural = pluralOf(lower)
  if (plural) return plural
  const hint = pronunciations[lower]
  if (hint) return hint
  if (looksLikeAcronym(folded)) return spellAcronym(folded)
  return ruleTransliterate(folded)
}

/**
 * Replaces every Latin word in a line, leaving Cyrillic, numbers and
 * punctuation exactly where they were.
 *
 * A hyphen inside a Latin token becomes a space: «Wi-Fi» is two Russian words.
 * An apostrophe does not: «don't» and «user's» are one spoken word.
 *
 * `pronunciations` carries the model's hints for words the dictionary does not
 * know; only the string sent to synthesis is affected.
 */
export function transliterate(
  text: string,
  pronunciations: Readonly<Record<string, string>> = {}
): string {
  return text.replace(LATIN_WORD, (token) => {
    const whole = dictionaryForm(foldLatin(token).toLowerCase())
    if (whole) return whole
    return token
      .split(/['’-]/)
      .filter(Boolean)
      .map((part) => transliterateWord(part, pronunciations))
      .join(token.includes('-') ? ' ' : '')
  })
}
