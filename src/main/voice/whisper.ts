/**
 * Local speech-to-text with whisper.cpp.
 *
 * The model and the binary stay on the machine: audio never leaves it, there is
 * no key, no quota and no request to wait for. `whisper-cli` is called as a child
 * process with a 16 kHz mono WAV — exactly the format the model expects — so the
 * renderer records in that format and nothing has to be resampled here.
 *
 * Everything degrades gracefully: a missing binary or model is not an exception
 * in the middle of a hotkey press, it is a `VoiceStatus` the settings window can
 * explain and fix, plus a failed turn that leaves the card exactly as it was.
 */

import { spawn } from 'node:child_process'
import { createWriteStream, existsSync } from 'node:fs'
import { copyFile, mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { cpus, homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { app } from 'electron'
import {
  WHISPER_MODELS,
  WHISPER_MODEL_BASE_URL,
  whisperModel,
  type WhisperModelMeta
} from '@shared/defaults'
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

const BINARY_NAME = 'whisper-cli'

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/** `~/Library/Application Support/Smart Cursor/models` once installed. */
export function modelsDir(): string {
  return join(app.getPath('userData'), 'models')
}

/**
 * The bundled binary wins; a Homebrew `whisper-cli` is the fallback so a user who
 * already installed whisper.cpp does not have to build anything.
 */
export function resolveBinary(): string | null {
  const bundled = app.isPackaged
    ? [join(process.resourcesPath, BINARY_NAME)]
    : [join(app.getAppPath(), 'resources', BINARY_NAME), join(process.cwd(), 'resources', BINARY_NAME)]
  for (const candidate of [...bundled, '/opt/homebrew/bin/whisper-cli', '/usr/local/bin/whisper-cli']) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

function isModelFile(name: string): boolean {
  return /^ggml-.*\.bin$/.test(name)
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
  return WHISPER_MODELS.filter((model) => present.has(model.file)).map((model) => model.id)
}

/**
 * The model that will actually be used: the configured one when its file is
 * around, otherwise the largest `ggml-*.bin` found anywhere — a bigger whisper is
 * a strictly better transcript for the same short command.
 */
export async function resolveModel(): Promise<{ path: string | null; auto: boolean }> {
  const configured = whisperModel(getSettings().voice.model)
  if (configured) {
    const inAppDir = join(modelsDir(), configured.file)
    if (existsSync(inAppDir)) return { path: inAppDir, auto: false }
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
  const binary = resolveBinary()
  const model = await resolveModel()
  let detail: string | null = null
  if (!binary) detail = 'Не найден whisper-cli — пересоберите приложение (npm run build:whisper).'
  else if (!model.path) detail = 'Не скачана модель распознавания — выберите её в настройках.'
  return {
    ready: Boolean(binary && model.path),
    detail,
    modelPath: model.path,
    binaryPath: binary,
    modelsDir: modelsDir(),
    installed: await installedModels(),
    // Filled in by the controller: the tap lives there, not in this module.
    listenerError: null,
    gestureError: null
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
 * Runs whisper on one recording.
 *
 * The model is loaded from scratch on every call — about a second for a phrase on
 * Apple Silicon — which keeps the process simple: no daemon to supervise, nothing
 * to leak between turns, and a crash costs exactly one turn.
 */
export async function transcribe(options: TranscribeOptions): Promise<TranscribeResult> {
  const startedAt = Date.now()
  const binary = resolveBinary()
  if (!binary) return { ok: false, text: '', ms: 0, message: 'Не найден whisper-cli.' }

  const model = await resolveModel()
  if (!model.path) {
    return { ok: false, text: '', ms: 0, message: 'Не скачана модель распознавания.' }
  }

  const dir = join(tmpdir(), `smartcursor-voice-${Date.now().toString(36)}`)
  await mkdir(dir, { recursive: true })
  const wavPath = join(dir, 'input.wav')
  try {
    await writeFile(wavPath, options.wav)
    const raw = await runWhisper(binary, model.path, wavPath, options.signal)
    const ms = Date.now() - startedAt
    if (options.signal?.aborted) return { ok: false, text: '', ms, message: 'Отменено.' }
    const text = cleanTranscript(raw)
    if (!text) {
      // Silence is not alarming, but it must not look like a successful empty
      // answer either: the card would sit there with nothing in it.
      return { ok: false, text: '', ms, message: 'Речь не распознана — попробуйте ещё раз.' }
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

function runWhisper(
  binary: string,
  modelPath: string,
  wavPath: string,
  signal?: AbortSignal
): Promise<string> {
  const language = getSettings().voice.language || 'ru'
  // Two threads per core is wasted on a short phrase: the GPU backend does the
  // heavy lifting, these threads only feed it.
  const threads = String(Math.max(2, Math.min(8, Math.floor(cpus().length / 2))))

  return new Promise((resolve, reject) => {
    const child = spawn(
      binary,
      [
        '-m',
        modelPath,
        '-f',
        wavPath,
        '-l',
        language,
        // No timestamps and no banner: stdout is the transcript, not a log.
        '-nt',
        '-np',
        '-t',
        threads
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    )

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
      stderr = (stderr + chunk).slice(-2000)
    })
    child.on('error', (error) => {
      cleanup()
      reject(error)
    })
    child.on('close', (code) => {
      cleanup()
      if (code === 0 || stdout.trim()) resolve(stdout)
      else reject(new Error(firstLine(stderr) || `whisper-cli завершился с кодом ${code}.`))
    })
  })
}

function firstLine(text: string): string {
  const line = text.split('\n').find((item) => item.trim())
  return line?.trim().slice(0, 300) ?? ''
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
 * download can never be picked up by `resolveModel()` as a usable model.
 */
export function downloadModel(
  id: string,
  onProgress: (progress: DownloadProgress) => void
): Promise<void> {
  const running = downloads.get(id)
  if (running) return running

  const meta: WhisperModelMeta | undefined = whisperModel(id)
  if (!meta) return Promise.reject(new Error('unknown-model'))

  const target = join(modelsDir(), meta.file)
  const part = `${target}.part`

  const task = (async (): Promise<void> => {
    await mkdir(modelsDir(), { recursive: true })
    const response = await fetch(`${WHISPER_MODEL_BASE_URL}/${meta.file}`)
    if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`)

    const total = Number(response.headers.get('content-length') ?? 0) || meta.mb * 1024 * 1024
    const sink = createWriteStream(part)
    const reader = response.body.getReader()
    let received = 0
    let lastEmit = 0
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        received += value.byteLength
        sink.write(Buffer.from(value))
        // Throttled: a progress event per chunk would flood the IPC channel.
        const now = Date.now()
        if (now - lastEmit > 120) {
          lastEmit = now
          onProgress({ model: id, received, total, done: false })
        }
      }
    } finally {
      await new Promise<void>((resolve) => sink.end(resolve))
    }
    await rename(part, target)
    onProgress({ model: id, received, total, done: true })
  })()
    .catch((error: unknown) => {
      void rm(part, { force: true })
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
