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
 * - A dictionary of terms that appear in answers constantly. It also carries
 *   the stress mark (`+` before the vowel), because a neural stress model can
 *   guess wrong on a foreign word it has never seen.
 * - Rules for everything else. They are an approximation, not a phonetic
 *   transcription; an unknown word will sound Russian-accented, which is the
 *   point. The stress model runs after this and places the marks on words the
 *   dictionary did not cover.
 *
 * The result is only ever fed to synthesis. The card, the settings and the cache
 * keep the original text: the user must not see «р+идми» instead of «README».
 */

/** Dictionary values are already Cyrillic; `+` marks the stressed vowel. */
const WORDS: Record<string, string> = {
  // Files, apps and the interface
  readme: 'р+идми',
  file: 'ф+айл',
  files: 'ф+айлы',
  folder: 'ф+олдер',
  open: '+опен',
  close: 'кл+оуз',
  save: 'сейв',
  delete: 'дел+ит',
  run: 'ран',
  stop: 'стоп',
  start: 'старт',
  click: 'клик',
  type: 'тайп',
  press: 'пресс',
  select: 'сил+ект',
  search: 'сёрч',
  view: 'вью',
  settings: 'с+еттингс',
  window: 'у+индоу',
  screen: 'скрин',
  app: 'эп',
  panel: 'пан+ель',
  menu: 'мен+ю',
  button: 'б+аттон',
  tab: 'тэб',
  page: 'пейдж',
  link: 'линк',
  copy: 'к+опи',
  paste: 'пейст',
  cut: 'кат',
  undo: 'анд+у',
  redo: 'рид+у',
  note: 'н+оут',
  list: 'лист',
  item: '+айтем',
  name: 'нейм',
  text: 'текст',
  line: 'лайн',
  word: 'у+орд',
  number: 'н+амбер',
  value: 'в+элью',
  data: 'д+ейта',
  image: '+имидж',
  media: 'м+едиа',
  video: 'в+идео',
  audio: '+аудио',
  voice: 'войс',
  sound: 'с+аунд',
  speech: 'спич',
  language: 'л+энгвидж',
  english: '+инглиш',
  russian: 'р+ашен',

  // Abbreviations are spelled out, not read as a word
  api: 'эй пи ай',
  url: 'ю ар эл',
  uri: 'ю ар ай',
  id: 'ай ди',
  ui: 'ю ай',
  ai: 'эй ай',
  os: 'о эс',
  db: 'ди би',
  http: 'эйч ти ти пи',
  https: 'эйч ти ти пи эс',
  html: 'эйч ти эм эл',
  css: 'си эс эс',
  json: 'дж+ейсон',
  yaml: 'й+амл',
  toml: 'т+омл',
  xml: 'экс эм эл',
  sdk: 'эс ди кей',
  cli: 'си эл ай',
  ide: 'ай ди и',
  pr: 'пи ар',
  ci: 'си ай',
  ssh: 'эс эс эйч',
  ftp: 'эф ти пи',
  dns: 'ди эн эс',
  ip: 'ай пи',
  vpn: 'ви пи эн',
  cpu: 'си пи ю',
  gpu: 'джи пи ю',
  ram: 'рам',
  usb: 'ю эс би',
  pdf: 'пи ди эф',
  png: 'пи эн джи',
  jpg: 'джей пи джи',
  gif: 'гиф',
  svg: 'эс ви джи',
  csv: 'си эс ви',
  sql: 'эс кью эл',
  llm: 'эл эл эм',

  // The assistant itself
  agent: '+ейджент',
  prompt: 'пр+омпт',
  model: 'мод+ель',
  token: 'т+окен',
  key: 'ки',
  cache: 'к+эш',
  server: 'с+ервер',
  client: 'кли+ент',
  database: 'д+ейтабейс',
  code: 'код',
  script: 'скр+ипт',
  terminal: 'т+ерминал',
  command: 'ком+анд',
  request: 'рикв+ест',
  response: 'рисп+онс',
  endpoint: 'эндп+оинт',
  service: 'с+ервис',
  provider: 'пров+айдер',
  version: 'в+ерсия',
  release: 'рил+из',
  feature: 'ф+ича',
  bug: 'баг',
  fix: 'фикс',
  review: 'ревь+ю',
  approve: 'апр+ув',
  deny: 'ден+ай',
  allow: 'алл+оу',
  block: 'блок',
  remember: 'рим+ембер',
  build: 'б+илд',
  deploy: 'депл+ой',
  commit: 'комм+ит',
  merge: 'мёрж',
  branch: 'бр+анч',
  issue: '+ишью',
  pull: 'пул',
  push: 'пуш',
  repo: 'р+епо',
  repository: 'рипозит+ори',
  github: 'гитх+аб',
  git: 'гит',
  npm: 'эн пи эм',
  python: 'п+айтон',
  javascript: 'джаваскр+ипт',
  typescript: 'тайпскр+ипт',
  react: 'ри+акт',
  node: 'н+оуд',
  electron: 'электр+он',
  swift: 'свифт',
  linux: 'л+инукс',
  windows: 'у+индоуз',
  macos: 'мак+ос',
  ios: 'ай+ос',
  iphone: 'айф+он',
  wifi: 'в+ай фай',
  google: 'г+угл',
  apple: '+эпл',
  microsoft: 'майкрос+офт',
  openai: '+опен эй ай',
  chatgpt: 'чат джи пи ти',

  // Requests and states
  email: 'им+ейл',
  internet: 'интерн+ет',
  website: 'в+ебсайт',
  web: 'веб',
  online: 'онл+айн',
  offline: 'офл+айн',
  update: 'апд+ейт',
  download: 'даунл+оуд',
  upload: 'апл+оуд',
  install: 'инст+ол',
  error: '+эрор',
  warning: 'в+орнинг',
  success: 'сакс+есс',
  fail: 'фейл',
  test: 'тест',
  true: 'тру',
  false: 'фолс',
  chat: 'чат',
  user: '+юзер',
  password: 'п+асворд',
  login: 'л+огин',
  account: 'акк+аунт',
  network: 'н+етворк',
  class: 'класс',
  object: '+обджект',
  array: 'арр+ей',
  function: 'ф+анкшен',
  import: 'имп+орт',
  export: '+экспорт',
  return: 'рит+ёрн',
  private: 'пр+айват',
  public: 'п+аблик',
  async: 'ас+инк',
  await: 'ав+ейт',

  // Function words: the rules mangle these, and they are everywhere
  the: 'зэ',
  a: 'э',
  an: 'эн',
  i: 'ай',
  he: 'хи',
  she: 'ши',
  me: 'ми',
  us: 'ас',
  him: 'хим',
  his: 'хиз',
  her: 'хёр',
  them: 'зем',
  their: 'зэр',
  our: '+ауэр',
  as: 'эз',
  because: 'бик+оз',
  about: 'аб+аут',
  into: '+инту',
  over: '+овер',
  under: '+андер',
  again: 'аг+ейн',
  maybe: 'м+ейби',
  of: 'оф',
  to: 'ту',
  in: 'ин',
  is: 'из',
  are: 'ар',
  and: 'энд',
  or: 'ор',
  for: 'фор',
  with: 'виз',
  this: 'зис',
  that: 'зэт',
  it: 'ит',
  we: 'ви',
  you: 'ю',
  my: 'май',
  your: 'йор',
  on: 'он',
  at: 'эт',
  from: 'фром',
  by: 'бай',
  be: 'би',
  not: 'нот',
  have: 'хэв',
  has: 'хэз',
  had: 'хэд',
  do: 'ду',
  does: 'даз',
  was: 'воз',
  were: 'вер',
  can: 'кэн',
  will: 'вил',
  but: 'бат',
  so: 'с+оу',
  if: 'иф',
  then: 'зэн',
  than: 'зэн',
  there: 'зэр',
  here: 'хир',
  what: 'у+от',
  when: 'у+эн',
  where: 'у+эр',
  why: 'у+ай',
  how: 'х+ау',
  who: 'ху',
  all: 'ол',
  some: 'сам',
  any: '+эни',
  more: 'мор',
  most: 'м+оуст',
  just: 'джаст',
  only: '+онли',
  also: '+олсоу',
  very: 'в+ери',
  now: 'н+ау',
  today: 'туд+эй',
  tomorrow: 'тум+ороу',
  yesterday: 'естерд+эй',

  // Common nouns outside a codebase
  computer: 'компь+ютер',
  laptop: 'лэпт+оп',
  phone: 'фон',
  message: 'месс+адж',
  notification: 'нотифик+ейшен',
  calendar: 'календ+арь',
  browser: 'бр+аузер',
  keyboard: 'к+иборд',
  mouse: 'м+аус',
  document: 'докьюм+ент',
  project: 'пр+оджект',
  problem: 'пробл+ем',
  question: 'кв+есчен',
  answer: '+ансер',
  time: 'тайм',
  date: 'дейт',
  day: 'дэй',
  week: 'у+ик',
  month: 'манс',
  year: 'йир',
  work: 'ворк',
  home: 'х+оум',
  city: 'с+ити',
  school: 'скул',
  money: 'м+ани',
  price: 'прайс',
  order: '+ордер',
  product: 'пр+одакт',
  support: 'сапп+орт',
  team: 'тим',
  news: 'ньюс',
  article: '+артикл',
  post: 'пост',
  comment: 'комм+ент',
  share: 'шер',
  like: 'лайк',
  follow: 'ф+оллоу',
  subscribe: 'сабскр+айб',

  // Everyday English
  ok: 'ок+ей',
  okay: 'ок+ей',
  please: 'плиз',
  thanks: 'с+энкс',
  sorry: 'с+орри',
  hello: 'хелл+оу',
  hi: 'хай',
  world: 'у+орлд',
  yes: 'йес',
  no: 'н+оу',
  good: 'гуд',
  bad: 'бэд',
  new: 'нью',
  old: '+олд',
  next: 'некст',
  back: 'бэк',
  forward: 'ф+орвард'
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

/** The placeholder stands in for the long vowel produced by a silent final `e`. */
const LONG_MARK = '\u0001'
const SOFT_G = '\u0002'
const SOFT_C = '\u0003'

function spellAcronym(word: string): string {
  return [...word.toLowerCase()].map((letter) => LETTER_NAMES[letter] ?? letter).join(' ')
}

function looksLikeAcronym(word: string): boolean {
  if (/^[A-Z]{2,6}$/.test(word)) return true
  // A lowercase short token with no vowel is an abbreviation too: `md`, `pkg`.
  return word.length >= 2 && word.length <= 3 && !/[aeiouy]/i.test(word)
}

function ruleTransliterate(input: string): string {
  let word = input.toLowerCase()

  // `file` → `fайл`: a vowel, one consonant and a silent final `e` make the
  // vowel long. A soft `g`/`c` before that `e` keeps its soft sound.
  const magic = /^(.*?)([aeiou])([^aeiou])e$/.exec(word)
  if (magic) {
    const [prefix, consonant] = [magic[1], magic[3]]
    const soft = consonant === 'g' ? SOFT_G : consonant === 'c' ? SOFT_C : consonant
    word = `${prefix}${LONG_MARK}${soft}`
  } else if (word.length > 2 && word.endsWith('e') && !/[aeiou]$/.test(word.slice(0, -1))) {
    word = word.slice(0, -1)
  }

  let out = ''
  for (let index = 0; index < word.length; ) {
    const char = word[index]
    if (char === LONG_MARK) {
      out += LONG_VOWELS[magic?.[2] ?? ''] ?? 'е'
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
    const singular = WORDS[stem] ?? WORDS[stem.replace(/['’-]/g, '')]
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

/** Whether the dictionary, the plural rule or the acronym rules can say this word. */
function needsPronunciation(word: string): boolean {
  const lower = word.toLowerCase()
  if (WORDS[lower] ?? WORDS[lower.replace(/['’-]/g, '')]) return false
  if (/^([A-Z]{2,6})s$/.test(word)) return false
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
  for (const token of text.match(/\p{Script=Latin}+(?:['’-]\p{Script=Latin}+)*/gu) ?? []) {
    const lower = token.toLowerCase()
    if (WORDS[lower] ?? WORDS[lower.replace(/['’-]/g, '')]) continue
    for (const part of token.split(/['’-]/).filter(Boolean)) {
      if (part.length < 2) continue
      if (needsPronunciation(part)) words.add(part.toLowerCase())
    }
  }
  return [...words]
}

function transliterateWord(word: string, pronunciations: Readonly<Record<string, string>>): string {
  const lower = word.toLowerCase()
  const known = WORDS[lower] ?? WORDS[lower.replace(/['’-]/g, '')]
  if (known) return known
  const acronymPlural = /^([A-Z]{2,6})s$/.exec(word)
  if (acronymPlural) return `${spellAcronym(acronymPlural[1])}с`
  const plural = pluralOf(lower)
  if (plural) return plural
  const hint = pronunciations[lower]
  if (hint) return hint
  if (looksLikeAcronym(word)) return spellAcronym(word)
  return ruleTransliterate(word)
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
  return text.replace(/\p{Script=Latin}+(?:['’-]\p{Script=Latin}+)*/gu, (token) => {
    const lower = token.toLowerCase()
    const whole = WORDS[lower] ?? WORDS[lower.replace(/['’-]/g, '')]
    if (whole) return whole
    return token
      .split(/['’-]/)
      .filter(Boolean)
      .map((part) => transliterateWord(part, pronunciations))
      .join(token.includes('-') ? ' ' : '')
  })
}
