/**
 * Russian pronunciation hints for words the seed dictionary does not know.
 *
 * Silero has no Latin letters in its vocabulary, so English terms are written in
 * Russian letters. The dictionary in `transliterate.ts` is deterministic but
 * finite, and Silero's stress model guesses wrong on foreign words it has never
 * seen. Here the configured text model is asked once per new term, and the
 * answer is cached on disk: the first answer with a new word pays one small
 * request, every later answer is free.
 *
 * Failure is not an error the user has to read. No key, no network, a timeout or
 * a malformed reply all return an empty map, and `transliterate` falls back to
 * its rules and Silero's stress model. Only the English terms are sent — never
 * the answer, the selection or the screen.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { app } from 'electron'
import { parseExtraBody, resolveBaseUrl } from '@shared/defaults'
import type { AppSettings } from '@shared/types'
import { getProvider, resolveChatModel } from '../llm'
import type { ChatMessage, StreamOptions } from '../llm/provider'
import { getApiKey } from '../settings/secrets'
import { getSettings } from '../settings/store'
import { unknownWords } from './transliterate'

/** Bump when the prompt or the validation changes what a cached value means. */
const CACHE_VERSION = 1
/** Long enough for a slow gateway, short enough not to outlive the answer. */
const LOOKUP_TIMEOUT_MS = 4_000
/**
 * How long synthesis waits for a hint before speaking with the rules.
 *
 * A miss is not a loss: the request keeps running and writes the cache, so the
 * same word is correct the next time it appears. Waiting the full timeout would
 * make the first offline line pause for seconds before it says anything.
 */
const LOOKUP_WAIT_MS = 1_800
/** One small request is cheaper than a long tail of one-word lookups. */
const MAX_TERMS = 40
const MAX_REPLY_CHARS = 8_000

const PROMPT = [
  'You spell English words the way a Russian speaker says them in technical speech.',
  'For every word in the user\'s JSON array, return one Russian spelling.',
  'Mark the stressed vowel with "+" immediately before it: "р+идми".',
  'Keep abbreviations as letter names: "API" becomes "эй пи ай".',
  'Do not translate: "delete" is "дел+ит", not "удалить".',
  'If you are not sure, use null.',
  'Return only a JSON object with the same keys, for example:',
  '{"README":"р+идми","localhost":"локалх+ост","Figma":"ф+игма"}'
].join('\n')

const VOWEL = /[аеёиоуыэюя]/i
const VOWELS = /[аеёиоуыэюя]/gi

type Hints = Record<string, string>

let cache: Hints | null = null
let loading: Promise<Hints> | null = null

function cachePath(): string {
  return join(app.getPath('userData'), 'tts-pronunciation.json')
}

/**
 * A hint is only useful if Silero can read it as one Russian word.
 *
 * Latin letters, digits and punctuation would be dropped or spoken literally by
 * the model, and a stress mark on the wrong letter is worse than no mark. A
 * multi-vowel word must carry exactly one mark before a vowel; a single-vowel
 * word may go without one.
 */
export function validPronunciation(value: string): boolean {
  const text = value.trim().toLowerCase()
  if (!text || !/^[а-яё+\s-]+$/i.test(text)) return false
  for (const word of text.split(/\s+/)) {
    if (!word) continue
    const mark = word.indexOf('+')
    if (mark === -1) {
      if ((word.match(VOWELS) ?? []).length >= 2) return false
      continue
    }
    if (word.indexOf('+', mark + 1) !== -1) return false
    if (!VOWEL.test(word[mark + 1] ?? '')) return false
  }
  return true
}

function parseReply(reply: string): Hints {
  const start = reply.indexOf('{')
  const end = reply.lastIndexOf('}')
  if (start < 0 || end <= start) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(reply.slice(start, end + 1))
  } catch {
    return {}
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
  const hints: Hints = {}
  for (const [word, value] of Object.entries(parsed)) {
    if (typeof value !== 'string') continue
    const key = word.trim().toLowerCase()
    const pronunciation = value.trim().toLowerCase()
    if (key && validPronunciation(pronunciation)) hints[key] = pronunciation
  }
  return hints
}

async function loadCache(): Promise<Hints> {
  if (cache) return cache
  loading ??= (async () => {
    try {
      const raw = JSON.parse(await readFile(cachePath(), 'utf8')) as { version?: number; words?: unknown }
      const words: Hints = {}
      if (raw.version === CACHE_VERSION && raw.words && typeof raw.words === 'object') {
        for (const [word, value] of Object.entries(raw.words)) {
          if (typeof value === 'string' && validPronunciation(value)) words[word] = value
        }
      }
      return words
    } catch {
      return {}
    }
  })().then((loaded) => {
    cache = loaded
    return loaded
  })
  return loading
}

async function saveCache(words: Hints): Promise<void> {
  try {
    await mkdir(dirname(cachePath()), { recursive: true })
    await writeFile(cachePath(), JSON.stringify({ version: CACHE_VERSION, words }))
  } catch (error) {
    // A full disk must not lose the hints already in memory.
    console.warn('[tts] unable to cache pronunciation hints:', error)
  }
}

/** Resolves with the promise's value, or `null` after `ms`; the promise keeps running. */
function waitFor<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms)
    promise.then(
      (value) => { clearTimeout(timer); resolve(value) },
      () => { clearTimeout(timer); resolve(null) }
    )
  })
}

async function askModel(terms: string[], settings: AppSettings): Promise<Hints> {
  const model = resolveChatModel(settings)
  const apiKey = getApiKey(settings.provider)
  if (!model || !apiKey) return {}

  const messages: ChatMessage[] = [
    { role: 'system', parts: [{ type: 'text', text: PROMPT }] },
    { role: 'user', parts: [{ type: 'text', text: JSON.stringify(terms) }] }
  ]
  const options: StreamOptions = {
    model,
    temperature: 0,
    maxTokens: 1_200,
    baseUrl: resolveBaseUrl(settings.provider, settings.baseUrls[settings.provider]),
    extraBody: parseExtraBody(settings.extraBody[settings.provider]) ?? undefined,
    signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS)
  }

  let reply = ''
  const stream = getProvider(settings.provider).stream(messages, apiKey, options)
  try {
    for (;;) {
      const next = await stream.next()
      if (next.done) break
      reply += next.value.delta
      if (reply.length > MAX_REPLY_CHARS) {
        await stream.return()
        break
      }
    }
  } catch (error) {
    // The words themselves are never logged.
    console.warn('[tts] pronunciation lookup failed:', error instanceof Error ? error.message : String(error))
    return {}
  }
  return parseReply(reply)
}

/**
 * Hints for the words in this line, from the cache or the text model.
 *
 * The result is keyed by lowercase Latin word and only ever reaches the string
 * handed to synthesis. An empty map is a normal outcome, not an error.
 */
export async function resolvePronunciations(text: string): Promise<Hints> {
  const settings = getSettings()
  if (settings.tts.pronunciationLookup === false) return {}

  const terms = unknownWords(text).slice(0, MAX_TERMS)
  if (terms.length === 0) return {}

  const words = await loadCache()
  const hints: Hints = {}
  const missing: string[] = []
  for (const term of terms) {
    const cached = words[term]
    if (cached) hints[term] = cached
    else missing.push(term)
  }
  if (missing.length === 0) return hints

  const lookup = askModel(missing, settings)
    .catch((): Hints => ({}))
    .then(async (fetched) => {
      const accepted: Hints = {}
      for (const term of missing) {
        const value = fetched[term]
        if (value) accepted[term] = value
      }
      if (Object.keys(accepted).length > 0) {
        Object.assign(words, accepted)
        await saveCache(words)
      }
      return accepted
    })
  const fetched = await waitFor(lookup, LOOKUP_WAIT_MS)
  if (!fetched || Object.keys(fetched).length === 0) return hints
  return { ...hints, ...fetched }
}
