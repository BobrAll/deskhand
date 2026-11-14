/**
 * Russian pronunciation hints for words the seed dictionary does not know.
 *
 * Silero has no Latin letters in its vocabulary, so English terms are written in
 * Russian letters. The dictionary in `transliterate.ts` is deterministic but
 * finite, and Silero's stress model guesses wrong on foreign words it has never
 * seen. Here the configured text model is asked once per new term, and the
 * answer is cached on disk: the first answer with a new word pays one small
 * request, every later answer is free. `prefetchPronunciations` lets the card
 * warm that cache from the prompt and the half-streamed answer, so the word is
 * often already known by the time it is spoken instead of only on the next one.
 *
 * Failure is not an error the user has to read. No key, no network, a timeout or
 * a malformed reply all return an empty map, and `transliterate` falls back to
 * its rules and Silero's stress model. Only the English terms are sent — never
 * the answer, the selection or the screen.
 */

import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
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
const LOOKUP_WAIT_MS = 800
/**
 * After a lookup that did not answer in time, stop paying the wait on every line.
 *
 * A blackholed network or a reasoning model would otherwise add the wait to each
 * new word and each answer. The running request still finishes in the background
 * and clears the backoff when it actually produces hints.
 */
const LOOKUP_BACKOFF_MS = 10 * 60_000
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
/** While this is in the future, a miss uses the rules instead of waiting again. */
let unavailableUntil = 0
/** The provider configuration the backoff belongs to; a change retries at once. */
let unavailableFor = ''
/** One provider request at a time; every line waits on the same one. */
let activeLookup: Promise<Hints> | null = null
/** The words `activeLookup` already carries, so they are not asked for twice. */
const activeTerms = new Set<string>()
/**
 * Words that arrived while a request was already running.
 *
 * The line that needed them speaks with the rules; once the running request
 * settles they are asked for in the background, so the next line gets the hint
 * instead of losing the word for the rest of the answer.
 */
const pendingTerms = new Set<string>()

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
    // A model may punctuate the value as a sentence; the punctuation is not part
    // of the pronunciation Silero receives.
    const pronunciation = value.trim().toLowerCase().replace(/[.,;:!?…]+$/, '')
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

/** Serialises writes so an older snapshot cannot land after a newer one. */
let saving: Promise<void> = Promise.resolve()

function saveCache(words: Hints): Promise<void> {
  const target = cachePath()
  const temporary = `${target}.part`
  const write = async (): Promise<void> => {
    try {
      await mkdir(dirname(target), { recursive: true })
      // A crash mid-write leaves a `.part` file, never a truncated cache that
      // the next launch would read as a valid dictionary.
      await writeFile(temporary, JSON.stringify({ version: CACHE_VERSION, words }))
      await rename(temporary, target)
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined)
      // A full disk must not lose the hints already in memory.
      console.warn('[tts] unable to cache pronunciation hints:', error)
    }
  }
  saving = saving.then(write, write)
  return saving
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
  } catch {
    // The caller logs one timeout and backs off; a courtesy lookup must not fill
    // the log with one line per sentence that happened while it was silent.
    return {}
  }
  return parseReply(reply)
}

/**
 * True when a model and a key exist and this exact configuration's backoff has
 * expired.
 */
function lookupAllowed(settings: AppSettings): boolean {
  const model = resolveChatModel(settings)
  let apiKey: string | null
  try {
    apiKey = getApiKey(settings.provider)
  } catch {
    // A broken secrets store is not a reason to fail synthesis on every line;
    // it only means this courtesy lookup is unavailable.
    return false
  }
  if (!model || !apiKey) return false
  // Switching to a faster provider or model, or rotating the key, is a reason
  // to try again now, not to serve the rest of the old backoff window. The key
  // itself never stays in module state — only a fingerprint of it.
  const keyId = createHash('sha256').update(apiKey).digest('hex')
  const config = [settings.provider, model,
    settings.baseUrls[settings.provider] ?? '', keyId].join('\u0000')
  if (config !== unavailableFor) {
    unavailableFor = config
    unavailableUntil = 0
    // The request that armed the old backoff belongs to the old configuration.
    // Its result is still cached when it settles, but it must not keep serving
    // this line: the new key or model is allowed to start its own request.
    activeLookup = null
    activeTerms.clear()
  }
  return Date.now() >= unavailableUntil
}

/** Starts the one request that is allowed at a time and caches what it answers. */
function startLookup(terms: string[], settings: AppSettings, words: Hints): Promise<Hints> {
  for (const term of terms) activeTerms.add(term)
  const lookup = askModel(terms, settings)
    .catch((): Hints => ({}))
    .then(async (fetched) => {
      const accepted: Hints = {}
      for (const term of terms) {
        const value = fetched[term]
        if (value) accepted[term] = value
      }
      if (Object.keys(accepted).length > 0) {
        unavailableUntil = 0
        Object.assign(words, accepted)
        await saveCache(words)
      }
      return accepted
    })
  activeLookup = lookup
  void lookup.finally(() => {
    if (activeLookup !== lookup) return
    activeLookup = null
    activeTerms.clear()
    startQueuedLookup(words)
  })
  return lookup
}

/**
 * Asks for the words that arrived while another request ran.
 *
 * Best effort: their own line has already spoken with the rules, so nothing
 * waits here. A failure leaves them out of the cache, and the next line that
 * needs one queues it again.
 */
function startQueuedLookup(words: Hints): void {
  for (const term of pendingTerms) {
    if (words[term]) pendingTerms.delete(term)
  }
  if (pendingTerms.size === 0 || activeLookup) return
  const settings = getSettings()
  // A missing key or an active backoff would fail the same way the request that
  // just settled did, and waiting for it is exactly what the backoff prevents.
  if (settings.tts.pronunciationLookup === false || !lookupAllowed(settings)) {
    pendingTerms.clear()
    return
  }
  const terms = [...pendingTerms].slice(0, MAX_TERMS)
  for (const term of terms) pendingTerms.delete(term)
  startLookup(terms, settings, words)
}

/**
 * Hints for the words in this line, from the cache or the text model.
 *
 * The result is keyed by lowercase Latin word and only ever reaches the string
 * handed to synthesis. An empty map is a normal outcome, not an error.
 */
export async function resolvePronunciations(text: string): Promise<Hints> {
  const settings = getSettings()
  if (settings.tts.pronunciationLookup === false) {
    // Turning the feature back on is a fresh start, not the rest of an old
    // backoff window from before it was disabled.
    unavailableUntil = 0
    unavailableFor = ''
    return {}
  }

  const found = await collectHints(text)
  if (!found) return {}
  const { cached: hints, missing, words } = found
  if (missing.length === 0) return hints
  if (!lookupAllowed(settings)) return hints

  // Streamed sentences are prepared one after another, but a provider that is
  // slow to answer would still see a request per line. One active request is
  // shared by every line that needs its words; the rest are queued behind it.
  if (activeLookup && !queueUncovered(missing)) {
    // The running request carries none of this line's words, so waiting for it
    // cannot help: speak with the rules and let the queued words arrive later.
    return hints
  }
  const lookup = activeLookup ?? startLookup(missing, settings, words)

  const fetched = await waitFor(lookup, LOOKUP_WAIT_MS)
  if (!fetched) {
    // The request keeps running and will cache its answer; until then, do not
    // make the next line wait for the same silence. One line in the log is
    // enough for a courtesy feature that is clearly not available.
    unavailableUntil = Date.now() + LOOKUP_BACKOFF_MS
    console.warn('[tts] pronunciation lookup did not answer; using the rules for a while')
    return hints
  }
  for (const term of missing) {
    const value = fetched[term]
    if (value) hints[term] = value
  }
  return hints
}

/**
 * Warms the cache for words in text the assistant is about to say.
 *
 * The prompt is known while the model is still thinking, and an answer is known
 * a sentence before it is spoken; both are enough time for the lookup to finish
 * without making the line wait. This is only a bet, so it never waits itself and
 * never arms the backoff: a lost bet must not change how the next line sounds.
 *
 * Availability is checked by the caller in `tts/index.ts`: this module does not
 * know whether synthesis can run at all.
 */
export async function prefetchHints(text: string): Promise<void> {
  const settings = getSettings()
  if (settings.tts.pronunciationLookup === false) return
  // Hints are only read by the local engine; a remote or system voice would pay
  // for a request whose answer never reaches synthesis.
  if (settings.tts.engine !== 'silero') return
  if (!lookupAllowed(settings)) return

  const found = await collectHints(text)
  if (!found || found.missing.length === 0) return
  if (activeLookup) {
    queueUncovered(found.missing)
    return
  }
  void startLookup(found.missing, settings, found.words)
}

/** What the cache already knows for a line, and what it would have to ask for. */
interface FoundHints {
  cached: Hints
  missing: string[]
  words: Hints
}

/**
 * Splits the unknown words of a line into cached hints and terms to look up.
 *
 * `null` means the line has no Latin words the dictionary cannot say, which is
 * the common case and needs neither the cache nor a request.
 */
async function collectHints(text: string): Promise<FoundHints | null> {
  const terms = unknownWords(text).slice(0, MAX_TERMS)
  if (terms.length === 0) return null
  const words = await loadCache()
  const cached: Hints = {}
  const missing: string[] = []
  for (const term of terms) {
    const hint = words[term]
    if (hint) cached[term] = hint
    else missing.push(term)
  }
  return { cached, missing, words }
}

/**
 * Queues terms the running request does not carry; says whether it carries any.
 *
 * A covered term means the caller can wait on that request for its own hint.
 */
function queueUncovered(terms: string[]): boolean {
  let covered = false
  for (const term of terms) {
    if (activeTerms.has(term)) covered = true
    else pendingTerms.add(term)
  }
  return covered
}
