/**
 * Local speech-to-text with native command-line recognizers.
 *
 * The model and the binary stay on the machine: audio never leaves it, there is
 * no key, no quota and no request to wait for. The recognizer runs as a child
 * process with a 16 kHz mono WAV — exactly the format the model expects — so the
 * renderer records in that format and nothing has to be resampled here.
 *
 * Everything degrades gracefully: a missing binary or model is not an exception
 * in the middle of a hotkey press, it is a `VoiceStatus` the settings window can
 * explain and fix, plus a failed turn that leaves the card exactly as it was.
 */

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createWriteStream, existsSync } from 'node:fs'
import { copyFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { cpus, homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { app } from 'electron'
import { VOICE_MODELS, voiceModel, WHISPER_MODELS } from '@shared/defaults'
import { resourceCandidates } from '../paths'
import type { DownloadProgress, TranscribeResult, VoiceStatus } from '@shared/types'
import { getSettings } from '../settings/store'

/**
 * Directories a `ggml-*.bin` may already live in. Auto-discovery is not a
 * convenience: people who use whisper.cpp have models on disk already, and
 * silently re-downloading 500 MB that is already there is how an app gets closed.
 */
const MODEL_SEARCH_DIRS = [
  '/opt/homebrew/share/whisper.cpp/models',
  '/usr/local/share/whisper.cpp/models',
  join(homedir(), '.cache', 'whisper.cpp'),
  join(homedir(), 'Library', 'Application Support', 'whisper.cpp'),
  join(homedir(), 'whisper.cpp', 'models')
]

/** whisper.cpp wants a thread count; half the cores keeps the machine usable while it runs. */
const MIN_THREADS = 2
const MAX_THREADS = 8
/** Only the tail of stderr is kept, and only for the failure message. */
const STDERR_TAIL_CHARS = 2000
/** A failure is reported as one line: enough to identify it, not the whole log. */
const FIRST_LINE_CHARS = 300
/** Progress is a settings-window courtesy; ten updates a second is plenty. */
const PROGRESS_INTERVAL_MS = 120
/** A download that goes this long without a byte is treated as dead. */
const DOWNLOAD_IDLE_TIMEOUT_MS = 30_000

function binaryName(engine: 'whisper' | 'transcribe'): string {
  return engine === 'transcribe' ? 'transcribe-cli' : 'whisper-cli'
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/** `~/Library/Application Support/Deskhand/models` once installed. */
export function modelsDir(): string {
  return join(app.getPath('userData'), 'models')
}

/**
 * The bundled binary wins; a Homebrew `whisper-cli` is the fallback so a user who
 * already installed whisper.cpp does not have to build anything.
 */
export function resolveBinary(engine: 'whisper' | 'transcribe' = 'whisper'): string | null {
  const name = binaryName(engine)
  const candidates = resourceCandidates(name, [
    join('/opt/homebrew/bin', name),
    join('/usr/local/bin', name)
  ])
  return candidates.find((candidate) => existsSync(candidate)) ?? null
}

function isModelFile(name: string): boolean {
  return /^ggml-[^/\\]*\.bin$/.test(name)
}

/** Ids of the catalog models that are already on disk. */
export async function installedModels(): Promise<string[]> {
  let entries: string[] = []
  try {
    entries = await readdir(modelsDir())
  } catch {
    /* the directory appears on the first download */
  }
  const present = new Set(entries)
  const catalog = VOICE_MODELS.filter((model) => present.delete(model.file)).map((model) => model.id)
  return [...catalog, ...Array.from(present).filter(isModelFile).sort()]
}

/**
 * The model that will actually be used: the configured one when its file is
 * around, otherwise the largest `ggml-*.bin` found anywhere — a bigger whisper is
 * a strictly better transcript for the same short command.
 */
export async function resolveWhisperModel(
  configured = voiceModel(getSettings().voice.model)
): Promise<{ path: string | null; auto: boolean }> {
  if (configured) {
    const inAppDir = join(modelsDir(), configured.file)
    if (existsSync(inAppDir)) return { path: inAppDir, auto: false }
    if (configured.engine === 'transcribe') return { path: null, auto: false }
    for (const dir of MODEL_SEARCH_DIRS) {
      const candidate = join(dir, configured.file)
      if (existsSync(candidate)) return { path: candidate, auto: true }
    }
  }

  const found: Array<{ path: string; size: number }> = []
  for (const dir of [modelsDir(), ...MODEL_SEARCH_DIRS]) {
    let entries: string[] = []
    try {
      entries = await readdir(dir)
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!isModelFile(entry)) continue
      const path = join(dir, entry)
      try {
        found.push({ path, size: (await stat(path)).size })
      } catch {
        /* raced with a delete */
      }
    }
  }
  found.sort((a, b) => b.size - a.size)
  return { path: found[0]?.path ?? null, auto: true }
}

export async function voiceStatus(): Promise<VoiceStatus> {
  const voice = getSettings().voice
  const configured = voiceModel(voice.model)
  const engine = configured?.engine ?? 'whisper'
  const binary = resolveBinary(engine)
  const model = await resolveWhisperModel(configured)
  let detail: string | null = null
  if (!binary) {
    detail =
      engine === 'transcribe'
        ? 'Не найден transcribe-cli — выполни npm run build:transcribe.'
        : 'Не найден whisper-cli — пересобери приложение (npm run build:whisper).'
  }
  else if (!model.path) detail = 'Не скачана модель распознавания — выбери её в настройках.'
  return {
    ready: Boolean(binary && model.path),
    enabled: voice.enabled,
    detail,
    modelPath: model.path,
    binaryPath: binary,
    modelsDir: modelsDir(),
    installed: await installedModels(),
    // Filled in by the controller: the tap lives there, not in this module.
    listenerError: null
  }
}

// ---------------------------------------------------------------------------
// Transcription
// ---------------------------------------------------------------------------

/** These are whisper's own artefacts for silence, never something the user said. */
const NON_SPEECH =
  /^[\[(（]?\s*(music|applause|silence|blank_audio|no speech|inaudible)\s*[\])）]?[.!]?$/i

/** Drops timestamps and non-speech markers, then joins what is left. */
function cleanTranscript(raw: string): string {
  return raw
    .split('\n')
    .map((line) => line.trim().replace(/^\[[\d:.\s>-]+\]\s*/, ''))
    .filter((line) => line && !NON_SPEECH.test(line))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export interface TranscribeOptions {
  /** Raw WAV bytes: 16 kHz, mono, 16-bit. */
  wav: Buffer
  signal?: AbortSignal
}

/**
 * Runs the selected recognizer on one recording.
 *
 * The model is loaded from scratch on every call — about a second for a phrase on
 * Apple Silicon — which keeps the process simple: no daemon to supervise, nothing
 * to leak between turns, and a crash costs exactly one turn.
 */
export async function transcribe(options: TranscribeOptions): Promise<TranscribeResult> {
  const startedAt = Date.now()
  const voice = getSettings().voice
  const configured = voiceModel(voice.model)
  const engine = configured?.engine ?? 'whisper'
  const binary = resolveBinary(engine)
  if (!binary) return { ok: false, text: '', ms: 0, message: `Не найден ${binaryName(engine)}.` }

  const model = await resolveWhisperModel(configured)
  if (!model.path) {
    return { ok: false, text: '', ms: 0, message: 'Не скачана модель распознавания.' }
  }

  const dir = join(tmpdir(), `deskhand-voice-${randomUUID()}`)
  await mkdir(dir, { recursive: true })
  const wavPath = join(dir, 'input.wav')
  try {
    await writeFile(wavPath, options.wav)
    const language = configured?.language ?? (voice.language || 'ru')
    const threads = String(Math.max(MIN_THREADS, Math.min(MAX_THREADS, Math.floor(cpus().length / 2))))
    const transcriptPath = join(dir, 'transcript.txt')
    const args =
      engine === 'transcribe'
        ? ['-m', model.path, '-l', language, '--timestamps', 'none', '-o', transcriptPath, wavPath]
        : ['-m', model.path, '-f', wavPath, '-l', language, '-nt', '-np', '-t', threads]
    if (options.signal?.aborted) return { ok: false, text: '', ms: 0, message: 'Отменено.' }
    const raw = await runRecognizer(binary, args, engine, options.signal)
    const ms = Date.now() - startedAt
    if (options.signal?.aborted) return { ok: false, text: '', ms, message: 'Отменено.' }
    const text = cleanTranscript(
      engine === 'transcribe' ? await readFile(transcriptPath, 'utf8') : raw
    )
    if (!text) {
      // Silence is not alarming, but it must not look like a successful empty
      // answer either: the card would sit there with nothing in it.
      return { ok: false, text: '', ms, message: 'Речь не распознана — попробуй ещё раз.' }
    }
    return { ok: true, text, ms }
  } catch (error) {
    return {
      ok: false,
      text: '',
      ms: Date.now() - startedAt,
      message: error instanceof Error ? error.message : 'Распознавание не удалось.'
    }
  } finally {
    void rm(dir, { recursive: true, force: true })
  }
}

function runRecognizer(
  binary: string,
  args: string[],
  engine: 'whisper' | 'transcribe',
  signal?: AbortSignal
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] })

    let stdout = ''
    let stderr = ''
    const onAbort = (): void => {
      child.kill('SIGKILL')
    }
    const cleanup = (): void => {
      signal?.removeEventListener('abort', onAbort)
    }
    signal?.addEventListener('abort', onAbort, { once: true })

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
    })
    // Kept short and only for the error message: whisper is chatty on stderr.
    child.stderr.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-STDERR_TAIL_CHARS)
    })
    child.on('error', (error) => {
      cleanup()
      reject(error)
    })
    child.on('close', (code) => {
      cleanup()
      if (code === 0 || (engine === 'whisper' && stdout.trim())) resolve(stdout)
      else {
        const detail = engine === 'whisper' ? firstLine(stderr) : ''
        reject(new Error(detail || `${binaryName(engine)} завершился с кодом ${code}.`))
      }
    })
  })
}

function firstLine(text: string): string {
  const line = text.split('\n').find((item) => item.trim())
  return line?.trim().slice(0, FIRST_LINE_CHARS) ?? ''
}

// ---------------------------------------------------------------------------
// Model downloads
// ---------------------------------------------------------------------------

const downloads = new Map<string, Promise<void>>()

export function isDownloading(id: string): boolean {
  return downloads.has(id)
}

/**
 * Downloads one catalog model into `modelsDir()`.
 *
 * Written to a `.part` file and renamed only when complete, so an interrupted
 * download can never be picked up by `resolveWhisperModel()` as a usable model.
 */
export function downloadModel(
  id: string,
  onProgress: (progress: DownloadProgress) => void
): Promise<void> {
  const running = downloads.get(id)
  if (running) return running

  const meta = voiceModel(id)
  if (!meta) return Promise.reject(new Error('unknown-model'))

  const target = join(modelsDir(), meta.file)
  const part = `${target}.part`

  const task = (async (): Promise<void> => {
    await mkdir(modelsDir(), { recursive: true })
    const controller = new AbortController()
    const timeout = new Error('Сервер загрузки модели не отвечает. Попробуй снова.')
    const abort = (): void => controller.abort(timeout)
    let timer = setTimeout(abort, DOWNLOAD_IDLE_TIMEOUT_MS)
    let received = 0
    let total = meta.mb * 1024 * 1024

    try {
      const response = await fetch(meta.url, { signal: controller.signal })
      if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`)

      const contentLength = Number(response.headers.get('content-length') ?? 0)
      total = contentLength || total
      const reader = response.body.getReader()
      async function* chunks(): AsyncGenerator<Uint8Array> {
        let lastEmit = 0
        try {
          for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            clearTimeout(timer)
            timer = setTimeout(abort, DOWNLOAD_IDLE_TIMEOUT_MS)
            received += value.byteLength
            const now = Date.now()
            if (now - lastEmit > PROGRESS_INTERVAL_MS) {
              lastEmit = now
              onProgress({ model: id, received, total, done: false })
            }
            yield value
          }
        } finally {
          reader.releaseLock()
        }
      }

      await pipeline(chunks(), createWriteStream(part), { signal: controller.signal })
      if (!received || (contentLength && !response.headers.has('content-encoding') && received !== contentLength)) {
        throw new Error('Файл модели загрузился не полностью. Попробуй снова.')
      }
    } catch (error) {
      if (controller.signal.aborted) throw timeout
      controller.abort()
      throw error
    } finally {
      clearTimeout(timer)
    }

    await rename(part, target)
    onProgress({ model: id, received, total, done: true })
  })()
    .catch(async (error: unknown) => {
      await rm(part, { force: true }).catch(() => undefined)
      onProgress({
        model: id,
        received: 0,
        total: 0,
        done: true,
        error: error instanceof Error ? error.message : 'Не удалось скачать модель.'
      })
      throw error
    })
    .finally(() => {
      downloads.delete(id)
    })

  downloads.set(id, task)
  return task
}

/** Removes only model files stored in the app's models directory. */
export async function deleteModel(id: string): Promise<void> {
  const model = voiceModel(id) ?? WHISPER_MODELS.find((model) => model.file === id)
  if (model && isDownloading(model.id)) throw new Error('Дождись окончания загрузки модели.')
  const file = model?.file ?? id
  if (!model && !isModelFile(file)) throw new Error('Неизвестная модель распознавания.')
  await rm(join(modelsDir(), file), { force: true })
}

/**
 * Imports a `ggml-*.bin` the user already has. A copy, not a symlink: the app
 * keeps working after the original file is moved.
 */
export async function importModel(source: string): Promise<string> {
  const name = source.split('/').pop() ?? ''
  if (!isModelFile(name)) throw new Error('Нужен файл модели whisper: ggml-*.bin.')
  await mkdir(modelsDir(), { recursive: true })
  await copyFile(source, join(modelsDir(), name))
  return WHISPER_MODELS.find((model) => model.file === name)?.id ?? name
}
