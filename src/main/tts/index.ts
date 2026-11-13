/**
 * Live speech synthesis for lines that were not recorded in advance.
 *
 * The assistant is audible without this module: its short lines ship as files
 * (see `src/shared/speechBank.ts` and `src/renderer/overlay/speechAudio.ts`).
 * This exists for the two things a recording cannot do — read an answer aloud in
 * the same voice, and speak a line in a voice the user chose afterwards.
 *
 * Three decisions are worth knowing:
 *
 * - Silero runs locally from weights installed on demand; the remote engine uses
 *   the endpoint, model and voice from settings. Its key is read only in main.
 * - **Every clip is cached on disk** by the full configuration plus the text, so
 *   a sentence is paid for once, and a change of voice is a new cache, not a
 *   stale file in the wrong voice.
 * - **Failure is not an error the user has to read.** No key, no network, a 500:
 *   all return `ok: false`, and the caller falls back to the macOS voice. Speech
 *   is a courtesy; it must never block the card.
 */

import { apiEndpoint } from '../llm/http'
import { app } from 'electron'
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AppSettings, TtsSettings, TtsStatus } from '@shared/types'
import { RECORDED, TTS_MAX_CHARS, sileroSpeaker, type TtsResult } from '@shared/tts'
import { getTtsKey } from '../settings/secrets'
import { getSettings } from '../settings/store'
import { resolvePronunciations } from './pronounce'
import {
  SILERO_CACHE_ID,
  sileroModelsReady,
  sileroRuntimeReady,
  synthesizeSilero,
  TRANSLITERATION_VERSION
} from './silero'

/** Long enough for a slow gateway, short enough not to outlive the answer. */
const TTS_TIMEOUT_MS = 20_000

/** One clip in flight per text; a repeated sentence waits for the first copy. */
const inFlight = new Map<string, Promise<TtsResult>>()

/**
 * Why the last request failed, if it did.
 *
 * A key can exist and still be refused the speech model, and that is invisible
 * from the settings alone. Remembering the last refusal lets the pane say what
 * actually happened instead of promising a voice the account does not have.
 */
let lastFailure: { config: string; message: string } | null = null

function cacheDir(): string {
  return join(app.getPath('userData'), 'tts-cache')
}

/** Separator for the cache-key fields: a character no setting or line can contain. */
const CACHE_KEY_SEPARATOR = '\u0000'

/**
 * Cache identity: the configuration *and* the text.
 *
 * Every field that changes the sound is in the key, so switching from one voice
 * to another never plays the previous voice's file. The key is deliberately not
 * part of it — rotating a key does not change the voice.
 */
function cacheKey(
  settings: TtsSettings,
  text: string,
  hints: Readonly<Record<string, string>> = {}
): string {
  let identity: Array<string | number> = [settings.baseUrl, settings.model, settings.voice, settings.style]
  if (settings.engine === 'silero') {
    // The weights come from a pinned release, so the version and the speaker are
    // the whole identity; hashing 300 MB on every line would be absurd. The hints
    // are part of it because a line first spoken before a hint arrived must not
    // keep the rule-based pronunciation forever.
    identity = [
      SILERO_CACHE_ID,
      sileroSpeaker(settings.sileroVoice),
      TRANSLITERATION_VERSION,
      Object.entries(hints)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([word, pronunciation]) => `${word}=${pronunciation}`)
        .join(CACHE_KEY_SEPARATOR)
    ]
  }
  return createHash('sha256')
    .update([...identity, text].join(CACHE_KEY_SEPARATOR))
    .digest('hex')
}

/** The remote engine answers in MP3; the local engine writes a WAV. */
function cacheExtension(settings: TtsSettings): 'mp3' | 'wav' {
  return settings.engine === 'remote' ? 'mp3' : 'wav'
}

function mimeFor(extension: 'mp3' | 'wav'): string {
  return extension === 'wav' ? 'audio/wav' : 'audio/mpeg'
}

/**
 * Why live synthesis cannot run, or null when it can.
 *
 * The single rule both `synthesize` and `ttsStatus` ask; exported so the
 * tests can assert each reason without spending a request.
 */
export function ttsBlockReason(settings: AppSettings = getSettings()): string | null {
  const tts = settings.tts
  if (!tts.enabled) return 'Синтез выключен.'
  if (tts.engine === 'silero') {
    if (!sileroRuntimeReady()) return 'Silero не установлен. Нажми «Скачать модель».'
    if (!sileroModelsReady()) return 'Нет модели Silero V5.6 RU. Нажми «Скачать модель».'
    return null
  }
  if (!tts.baseUrl) return 'Не указан адрес сервиса.'
  if (!tts.model) return 'Не указана модель.'
  if (!tts.voice) return 'Не указан голос.'
  if (!getTtsKey()) return 'Не указан ключ синтеза.'
  return null
}

/** Reads a cached clip, if one exists for exactly this configuration and text. */
async function readCache(key: string, extension: 'mp3' | 'wav'): Promise<TtsResult | null> {
  try {
    const file = await readFile(join(cacheDir(), `${key}.${extension}`))
    return { ok: true, audio: file.toString('base64'), cached: true, mime: mimeFor(extension) }
  } catch {
    return null
  }
}

async function writeCache(key: string, extension: 'mp3' | 'wav', audio: Buffer): Promise<void> {
  try {
    await mkdir(cacheDir(), { recursive: true })
    await writeFile(join(cacheDir(), `${key}.${extension}`), audio)
  } catch (error) {
    // A full disk must not lose the audio we already have in memory.
    console.warn('[tts] unable to cache a clip:', error)
  }
}

/**
 * Keeps the cache from growing for the life of the install.
 *
 * Every distinct answer sentence is a file, and an app that runs for a year
 * would collect thousands of them. The cap is generous — a clip is ~50 KB, so
 * the ceiling is tens of megabytes — and it only ever removes the oldest clips.
 */
const CACHE_LIMIT = 400

async function pruneCache(): Promise<void> {
  try {
    const dir = cacheDir()
    const names = (await readdir(dir)).filter((name) => name.endsWith('.mp3') || name.endsWith('.wav'))
    if (names.length <= CACHE_LIMIT) return
    const dated = await Promise.all(names.map(async (name) => {
      const info = await stat(join(dir, name)).catch(() => null)
      return { name, at: info?.mtimeMs ?? 0 }
    }))
    dated.sort((left, right) => left.at - right.at)
    for (const { name } of dated.slice(0, dated.length - CACHE_LIMIT)) {
      await unlink(join(dir, name)).catch(() => undefined)
    }
  } catch {
    // Pruning is housekeeping; a failure must not affect playback.
  }
}

async function requestSynthesis(text: string, settings: TtsSettings): Promise<TtsResult> {
  const key = getTtsKey()
  if (!key) return { ok: false, message: 'Ключ синтеза не настроен.' }

  let response: Response
  try {
    response = await fetch(apiEndpoint(settings.baseUrl, 'audio/speech').href, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: settings.model,
        input: text,
        voice: settings.voice,
        ...(settings.style ? { instructions: settings.style } : {}),
        response_format: 'mp3'
      }),
      signal: AbortSignal.timeout(TTS_TIMEOUT_MS)
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, message: /timeout|abort/i.test(message) ? 'Синтез не ответил вовремя.' : message }
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    return { ok: false, message: `Синтез ${response.status}${detail ? `: ${detail.slice(0, 120)}` : ''}` }
  }
  const body = await response.arrayBuffer().catch(() => null)
  if (!body) return { ok: false, message: 'Не удалось загрузить звук. Попробуй снова.' }
  const audio = Buffer.from(body)
  if (audio.length === 0) return { ok: false, message: 'Пустой ответ синтеза.' }
  return { ok: true, audio: audio.toString('base64'), cached: false, mime: 'audio/mpeg' }
}

/**
 * Speaks one line, from the cache when possible.
 *
 * The renderer splits long answers into clips before requesting synthesis.
 */
export async function synthesize(text: string, localOnly = false): Promise<TtsResult> {
  const line = text.trim()
  if (!line) return { ok: false, message: 'Нечего произносить.' }
  if (line.length > TTS_MAX_CHARS) return { ok: false, message: 'Фрагмент слишком длинный для синтеза.' }

  const settings = getSettings()
  if (localOnly && settings.tts.engine === 'remote') {
    return { ok: false, message: 'Локальный синтез выключен.' }
  }
  const blocked = ttsBlockReason(settings)
  if (blocked) return { ok: false, message: blocked }

  const hints = settings.tts.engine === 'silero' ? await resolvePronunciations(line) : {}
  const key = cacheKey(settings.tts, line, hints)
  const extension = cacheExtension(settings.tts)
  const running = inFlight.get(key)
  if (running) return running

  const cached = await readCache(key, extension)
  const pending = inFlight.get(key)
  if (pending) return pending
  if (cached) return cached

  const job = (settings.tts.engine === 'silero'
    ? synthesizeSilero(line, sileroSpeaker(settings.tts.sileroVoice), hints)
    : requestSynthesis(line, settings.tts))
    .then(async (result): Promise<TtsResult> => {
      if (result.ok) {
        await writeCache(key, extension, Buffer.from(result.audio, 'base64'))
        void pruneCache()
      } else {
        // The message explains which half failed; the line itself is never logged.
        console.warn('[tts] synthesis failed:', settings.tts.engine, result.message)
      }
      lastFailure = result.ok ? null : { config: JSON.stringify(settings.tts), message: result.message }
      return result
    })
    .finally(() => inFlight.delete(key))
  inFlight.set(key, job)
  return job
}

/**
 * What the settings pane shows about the voice.
 *
 * It answers "will a new line be spoken, and by what" without spending a
 * request: availability is a set of local facts. Named after the `TtsStatus` it
 * returns, which is also what the `tts.status` channel and `DeskhandApi.tts`
 * call it.
 */
export function ttsStatus(): TtsStatus {
  const settings = getSettings()
  const blocked = ttsBlockReason(settings)
  const silero = settings.tts.engine === 'silero'
  return {
    configured: blocked === null,
    // A configuration can be complete and still fail at the service; saying so
    // here is what keeps the pane from promising a voice that was refused.
    reason: blocked ?? (lastFailure?.config === JSON.stringify(settings.tts) ? lastFailure.message : null),
    engine: settings.tts.engine,
    voice: silero ? sileroSpeaker(settings.tts.sileroVoice) : settings.tts.voice,
    model: settings.tts.model,
    keyConfigured: Boolean(getTtsKey()),
    recordedVoice: RECORDED.voice,
    silero: silero ? { installed: sileroRuntimeReady() && sileroModelsReady() } : null
  }
}
