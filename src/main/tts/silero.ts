/**
 * The optional Silero V5.6 RU engine.
 *
 * Silero is not bundled: it is a Python package plus about 300 MB of ONNX
 * weights, downloaded the first time the user asks for the voice. The app stays
 * the same size for everyone who does not turn it on, and the download is a
 * single button in the settings rather than a dependency of the build.
 *
 * Silero has no Latin letters in its vocabulary, so `transliterate.ts` writes
 * English words in Russian letters. Words the seed dictionary does not know may
 * get a cached hint from the text model first (`pronounce.ts`); if that is
 * unavailable, the rules and the model's stress model still place the marks.
 * The card keeps the original text; only the string sent to synthesis is
 * rewritten.
 *
 * Three decisions:
 *
 * - **Nothing is installed without a click.** `installSilero` is called from the
 *   settings pane, and synthesis itself is offline. The one optional request is
 *   the cached pronunciation hint for a word the seed dictionary does not know;
 *   `tts.pronunciationLookup` gates it, and no hint is asked without it.
 * - **Every file is checked by SHA-256 before it is used.** The weights come
 *   from GitHub Releases, and a truncated download must read as "not installed",
 *   not as a model that produces silence.
 * - **Failure is a sentence, not a stack.** Missing Python, no network and a
 *   broken venv all return a reason the pane can show; speech falls back to the
 *   macOS voice exactly like every other engine failure.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { createWriteStream, existsSync, readFileSync } from 'node:fs'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { app } from 'electron'
import type { TtsSetupProgress } from '@shared/types'
import type { TtsResult } from '@shared/tts'
import { findPython, lastLine, run } from './python'
import { resolvePronunciations } from './pronounce'
import { SileroWorker, WORKER_SCRIPT, WORKER_SCRIPT_NAME } from './sileroWorker'
import { transliterate } from './transliterate'

/** Pinned: a new release changes the file list and the hashes below. */
const RUNTIME_VERSION = 'v0.5.0'
/** The commit behind the tag: a moved tag must not change what pip installs. */
const RUNTIME_URL =
  'https://github.com/some1-in-here/silero-tts-onnx/archive/10e5698504e14b39ffd5f72dc2c7b02bd7893747.tar.gz'
const RELEASE_URL = `https://github.com/some1-in-here/silero-tts-onnx/releases/download/${RUNTIME_VERSION}`

/**
 * The v5_6_ru set: four model files and two shared frontend models.
 *
 * `istft_48k.onnx` belongs to the older `v5_ru` pipeline; this version builds the
 * waveform in its own vocoder, so downloading the extra 92 MB would be waste.
 */
const MODEL_FILES = [
  ['acoustic_v5_6_ru.onnx', 26_440_521, 'da129dfadbd10741d836b9401508a257e24615d9d60af03811549a8f14bf6a57'],
  ['dur_predictor_v5_6_ru.onnx', 2_529_033, '0c2b7aa3ecf4b7288ea158228ada75eb966b8a10b5bf38bb1445498247d95c0c'],
  ['pitch_predictor_v5_6_ru.onnx', 2_528_662, 'b280b2bd65a0f36f750fe9de80a37c605c2af29b97a4d2cd90308c88a920346c'],
  ['vocoder_v5_6_ru.onnx', 150_783_704, '723df4f52b5dacebfc4fb96505be30f625f66a983e2fcc892ebb480bcd3e4d9a'],
  ['silero_stress.onnx', 117_110_329, '904056c963c8df0043770123fc68ab12703232ca19c70a593acfdf3647cb463b'],
  ['ngram_core.onnx', 8_248_515, 'ba02557b9e135b39dc25626c352c36af633fc94f97aba28949b52bf4dcb190d6']
] as const

const MODEL_BYTES = MODEL_FILES.reduce((sum, [, bytes]) => sum + bytes, 0)

/** Cache identity for the weights: a runtime upgrade must not reuse old clips. */
export const SILERO_CACHE_ID = `silero-v5_6_ru-${RUNTIME_VERSION}`

/** Bump when the transliteration dictionary or rules change the spoken text. */
export const TRANSLITERATION_VERSION = 5

const PIP_TIMEOUT_MS = 5 * 60_000
const MODEL_TIMEOUT_MS = 10 * 60_000
const SYNTHESIS_TIMEOUT_MS = 60_000
const WORKER_IDLE_TIMEOUT_MS = 3 * 60_000
/** A worker that hung once is not retried on every line of the same answer. */
const WORKER_BACKOFF_MS = 10 * 60_000
const STDERR_TAIL_CHARS = 2000
const PROGRESS_INTERVAL_MS = 150

/**
 * Loads the model once and synthesizes several Russian fragments.
 *
 * A line can contain several fragments after transliteration; one process keeps
 * the model warm and returns all of them in one pass.
 */
const BATCH_SCRIPT = `import json
import sys

from silero_onnx import SileroTTS

models, jobs_path, speaker = sys.argv[1:4]
tts = SileroTTS(model_dir=models)
with open(jobs_path, encoding="utf-8") as handle:
    jobs = json.load(handle)
for job in jobs:
    tts.synthesize_to_file(job["text"], job["output"], speaker=speaker)
`

function sileroDir(): string {
  return join(app.getPath('userData'), 'silero')
}

function sileroModelsDir(): string {
  return join(sileroDir(), 'models')
}

function venvPython(): string {
  return join(sileroDir(), 'venv', 'bin', 'python')
}

function runtimeMarker(): string {
  return join(sileroDir(), 'runtime.version')
}

function batchScript(): string {
  return join(sileroDir(), 'batch_tts.py')
}

function workerScript(): string {
  return join(sileroDir(), WORKER_SCRIPT_NAME)
}

/** The venv exists and was built from the pinned package version. */
export function sileroRuntimeReady(): boolean {
  if (!existsSync(venvPython()) || !existsSync(join(sileroDir(), 'venv', 'bin', 'silero-onnx'))) return false
  try {
    return readFileSync(runtimeMarker(), 'utf8').trim() === RUNTIME_VERSION
  } catch {
    return false
  }
}

/**
 * All six weights are present.
 *
 * Only existence is checked here: hashing 300 MB on every status read would make
 * the settings pane freeze. The hash is verified once, when the file is written.
 */
export function sileroModelsReady(): boolean {
  return MODEL_FILES.every(([file]) => existsSync(join(sileroModelsDir(), file)))
}

/** Downloads one file, hashing while it writes, and only then gives it its real name. */
async function downloadFile(
  url: string,
  target: string,
  sha256: string,
  timeoutMs: number,
  onBytes: (bytes: number) => void
): Promise<void> {
  const temporary = `${target}.part`
  const fileName = target.split('/').pop() ?? target
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
  if (!response.ok) throw new Error(`Не удалось скачать ${fileName}: ${response.status}.`)
  if (!response.body) throw new Error(`Пустой ответ при скачивании ${fileName}.`)

  const hash = createHash('sha256')
  // Hashing in the stream keeps the download one pass and the memory flat; a
  // separate `data` listener would switch the stream to flowing mode before the
  // file writer is attached.
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      hash.update(chunk)
      onBytes(chunk.length)
      callback(null, chunk)
    }
  })

  await mkdir(dirname(target), { recursive: true })
  try {
    await pipeline(
      Readable.fromWeb(response.body as import('node:stream/web').ReadableStream),
      meter,
      createWriteStream(temporary)
    )
  } catch (error) {
    // A transfer that dies halfway would otherwise leave up to 150 MB behind
    // until the next attempt or an uninstall.
    await rm(temporary, { force: true }).catch(() => undefined)
    throw error
  }
  if (hash.digest('hex') !== sha256) {
    await rm(temporary, { force: true })
    throw new Error(`Файл ${fileName} скачался повреждённым. Попробуй ещё раз.`)
  }
  await rename(temporary, target)
}

/** Downloads one weight, reporting progress across the whole model set. */
async function downloadModel(
  file: string,
  bytes: number,
  sha256: string,
  receivedBefore: number,
  onProgress: (progress: TtsSetupProgress) => void
): Promise<void> {
  const target = join(sileroModelsDir(), file)
  if (existsSync(target)) return

  let received = receivedBefore
  let lastReport = 0
  await downloadFile(`${RELEASE_URL}/${file}`, target, sha256, MODEL_TIMEOUT_MS, (delta) => {
    received += delta
    const now = Date.now()
    if (now - lastReport < PROGRESS_INTERVAL_MS) return
    lastReport = now
    onProgress({ stage: 'models', received, total: MODEL_BYTES, done: false })
  })
  onProgress({ stage: 'models', received: receivedBefore + bytes, total: MODEL_BYTES, done: false })
}

/**
 * The installation in progress, if any.
 *
 * Two pip runs into the same virtual environment would corrupt it, and a second
 * click must not start one. The second caller waits for the first result.
 */
let installation: Promise<string | null> | null = null

/**
 * Installs the runtime and every weight, reporting each stage.
 *
 * Re-running is safe and cheap when everything is already there: an installed
 * runtime is reused, and weights that already have their real names are skipped.
 */
export function installSilero(onProgress: (progress: TtsSetupProgress) => void): Promise<string | null> {
  if (!installation) {
    // A reinstall is not a quit: synthesis must be allowed again afterwards.
    shuttingDown = false
    // The venv is about to be replaced under the running workers.
    stopSileroWorker()
    installation = runInstall(onProgress).finally(() => {
      installation = null
    })
  }
  return installation
}

async function runInstall(onProgress: (progress: TtsSetupProgress) => void): Promise<string | null> {
  let stage: TtsSetupProgress['stage'] = 'python'
  try {
    if (!sileroRuntimeReady()) {
      onProgress({ stage, received: 0, total: 0, done: false })
      const python = await findPython()
      if (!python) {
        const message = 'Нужен Python 3.12 или новее. Поставь его и попробуй ещё раз.'
        onProgress({ stage, received: 0, total: 0, done: true, error: message })
        return message
      }

      const venv = join(sileroDir(), 'venv')
      await mkdir(sileroDir(), { recursive: true })
      if (!existsSync(venvPython())) {
        await run(python, ['-m', 'venv', venv], 120_000)
      }
      stage = 'runtime'
      onProgress({ stage, received: 0, total: 0, done: false })
      await run(
        venvPython(),
        ['-m', 'pip', 'install', '--disable-pip-version-check', '--no-input', RUNTIME_URL],
        PIP_TIMEOUT_MS
      )
      await writeFile(runtimeMarker(), `${RUNTIME_VERSION}\n`)
      await writeFile(batchScript(), BATCH_SCRIPT)
      await writeFile(workerScript(), WORKER_SCRIPT)
    }

    stage = 'models'
    let received = 0
    await mkdir(sileroModelsDir(), { recursive: true })
    onProgress({ stage, received, total: MODEL_BYTES, done: false })
    for (const [file, bytes, sha256] of MODEL_FILES) {
      await downloadModel(file, bytes, sha256, received, onProgress)
      received += bytes
    }

    onProgress({ stage, received: MODEL_BYTES, total: MODEL_BYTES, done: true })
    return null
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    onProgress({ stage, received: 0, total: 0, done: true, error: message })
    return message
  }
}

/**
 * Removes the venv and the weights.
 *
 * Clips already in the TTS cache stay: they are keyed by the pinned release and
 * the speaker, so a reinstall would produce the same audio for them.
 */
export async function removeSilero(): Promise<void> {
  stopSileroWorker()
  await rm(sileroDir(), { recursive: true, force: true })
}

/**
 * Writes a generated Python script when it is missing or its content changed.
 *
 * An app update may ship a different protocol or a fix in the script itself, so
 * a changed one must reach an existing install; an unchanged one must not be
 * rewritten on every phrase, because that disturbs a warm process.
 */
async function ensureScript(path: string, content: string): Promise<string> {
  try {
    if ((await readFile(path, 'utf8')) === content) return path
  } catch {
    /* the script appears on first use */
  }
  await mkdir(sileroDir(), { recursive: true })
  await writeFile(path, content)
  return path
}

/** One warm process per runtime and speaker, plus the fallback processes in flight. */
const sileroWorkers = new Map<string, SileroWorker>()
const oneShotProcesses = new Set<ChildProcess>()
/** While this is in the future, that worker key goes straight to the one-shot. */
let workerUnavailableUntil = 0
let workerUnavailableFor = ''
/** Set on quit so a fallback already in flight cannot spawn a new child. */
let shuttingDown = false

/**
 * Kills every Python child this module owns.
 *
 * Called on quit, uninstall and reinstall: a worker keeps 300 MB of weights in
 * memory and must never outlive the app.
 */
export function stopSileroWorker(): void {
  for (const worker of sileroWorkers.values()) worker.stop()
  sileroWorkers.clear()
  for (const child of oneShotProcesses) child.kill('SIGKILL')
  oneShotProcesses.clear()
  workerUnavailableUntil = 0
  workerUnavailableFor = ''
}

/**
 * Stops synthesis for good while the app is quitting.
 *
 * `stopSileroWorker` is also used by reinstall, where a later synthesis is
 * expected. This variant additionally blocks a fallback that is about to spawn
 * its own `batch_tts.py` after the sweep has already run.
 */
export function shutdownSilero(): void {
  shuttingDown = true
  stopSileroWorker()
}

function sileroEnvironment(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PYTHONUTF8: '1',
    PYTHONUNBUFFERED: '1',
    SILERO_ONNX_MODELS: sileroModelsDir(),
    SILERO_ONNX_CACHE: join(sileroDir(), 'cache')
  }
}

function workerKey(speaker: string, script: string): string {
  return [venvPython(), script, speaker].join('\u0000')
}

function workerFor(speaker: string, script: string): SileroWorker {
  const key = workerKey(speaker, script)
  const existing = sileroWorkers.get(key)
  if (existing) return existing

  const models = sileroModelsDir()
  const worker = new SileroWorker({
    spawnWorker: () =>
      spawn(venvPython(), [script, models, speaker], {
        env: sileroEnvironment(),
        stdio: ['pipe', 'pipe', 'pipe']
      }),
    requestTimeoutMs: SYNTHESIS_TIMEOUT_MS,
    idleTimeoutMs: WORKER_IDLE_TIMEOUT_MS,
    onTimeout: () => {
      // A silent interpreter is not going to answer the next line either. The
      // one-shot still speaks this one, but the rest of the answer should not
      // pay the same 60-second wait.
      workerUnavailableFor = key
      workerUnavailableUntil = Date.now() + WORKER_BACKOFF_MS
    }
  })
  sileroWorkers.set(key, worker)
  return worker
}

/** Why a Python child ended, when it wrote nothing useful to stderr. */
function exitReason(code: number | null, signal: NodeJS.Signals | null): string {
  if (signal) return `Процесс завершился сигналом ${signal}.`
  if (code !== null) return `Процесс завершился с кодом ${code}.`
  return 'Процесс завершился без кода.'
}

function spawnCaptured(command: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs: number): Promise<void> {
  if (shuttingDown) return Promise.reject(new Error('Синтез остановлен.'))
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ['ignore', 'ignore', 'pipe'] })
    oneShotProcesses.add(child)
    let stderr = ''
    let settled = false
    const settle = (error?: Error): void => {
      if (settled) return
      settled = true
      oneShotProcesses.delete(child)
      clearTimeout(timer)
      if (error) reject(error)
      else resolve()
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      settle(new Error('Синтез не ответил вовремя.'))
    }, timeoutMs)

    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-STDERR_TAIL_CHARS)
    })
    child.on('error', (error) => settle(error))
    child.on('close', (code, signal) => {
      if (code === 0) settle()
      else settle(new Error(lastLine(stderr) || exitReason(code, signal)))
    })
  })
}

/** Synthesizes Russian fragments with one model load. */
async function renderSilero(
  jobs: Array<{ text: string; output: string }>,
  speaker: string,
  directory: string
): Promise<void> {
  if (jobs.length === 0) return
  const script = await ensureScript(batchScript(), BATCH_SCRIPT)
  const jobsPath = join(directory, 'jobs.json')
  await writeFile(jobsPath, JSON.stringify(jobs))
  await spawnCaptured(
    venvPython(),
    [script, sileroModelsDir(), jobsPath, speaker],
    sileroEnvironment(),
    SYNTHESIS_TIMEOUT_MS
  )
}

/**
 * Speaks one fragment through the warm process, with the one-shot renderer as a
 * fallback. The fallback runs inside the worker queue, so the two model loads
 * never overlap.
 */
async function renderThroughWorker(
  job: { text: string; output: string },
  speaker: string,
  directory: string
): Promise<void> {
  if (shuttingDown) throw new Error('Синтез остановлен.')
  const renderOnceShot = (): Promise<void> => renderSilero([job], speaker, directory)

  let script: string
  try {
    script = await ensureScript(workerScript(), WORKER_SCRIPT)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.warn('[tts] unable to write the silero worker script (%s); using the one-shot renderer', message)
    await renderOnceShot()
    return
  }
  const key = workerKey(speaker, script)
  if (workerUnavailableFor === key && Date.now() < workerUnavailableUntil) {
    await renderOnceShot()
    return
  }
  // The backoff belongs to one worker key; a different speaker starts with none.
  if (workerUnavailableFor !== key) {
    workerUnavailableFor = key
    workerUnavailableUntil = 0
  }
  await workerFor(speaker, script).render(job.text, job.output, renderOnceShot, async () => {
    const audio = await readFile(job.output)
    if (audio.length === 0) throw new Error('Silero вернул пустой файл.')
  })
}

/**
 * Speaks one line with the downloaded model.
 *
 * Latin words are transliterated before they reach the model: Silero's
 * vocabulary has no Latin letters at all. The original text never changes, only
 * the string handed to synthesis. A word outside the seed dictionary may wait
 * for one cached hint from the text model; a failed lookup is not an error, it
 * simply leaves the word to the rules.
 */
export async function synthesizeSilero(
  text: string,
  speaker: string,
  hints?: Readonly<Record<string, string>>
): Promise<TtsResult> {
  if (shuttingDown) return { ok: false, message: 'Синтез остановлен.' }
  if (!sileroRuntimeReady()) return { ok: false, message: 'Silero не установлен.' }
  if (!sileroModelsReady()) return { ok: false, message: 'Нет модели Silero V5.6 RU.' }

  const pronunciations = hints ?? (await resolvePronunciations(text))
  const spoken = transliterate(text, pronunciations)
  if (!spoken.trim()) return { ok: false, message: 'Нечего произносить.' }

  const directory = join(tmpdir(), `deskhand-silero-${process.pid}-${randomUUID()}`)
  const output = join(directory, 'speech.wav')
  const job = { text: spoken, output }
  try {
    await mkdir(directory, { recursive: true })
    await renderThroughWorker(job, speaker, directory)
    const audio = await readFile(output).catch(() => null)
    if (!audio || audio.length === 0) return { ok: false, message: 'Silero вернул пустой файл.' }
    return { ok: true, audio: audio.toString('base64'), cached: false, mime: 'audio/wav' }
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : 'Silero не смог озвучить текст.'
    }
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined)
  }
}
