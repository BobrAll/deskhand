/**
 * The Silero wiring: a warm worker first, the one-shot renderer second.
 *
 * The fake child answers the way either Python script does, so this pins the
 * decision a user depends on — a worker that cannot start must still produce a
 * line through `batch_tts.py` — without the real interpreter or weights. The
 * same fake reproduces the failures that surface in the settings pane: a Python
 * crash, a signalled kill and a download that dies halfway.
 */

import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  spawns: [] as string[][],
  workerAnswers: false,
  /** Paths `existsSync` must report as absent; everything else is installed. */
  missing: new Set<string>(),
  scripts: new Map<string, string>(),
  written: [] as Array<{ path: string; data: string }>,
  removed: [] as string[],
  oneShot: { code: 0 as number | null, signal: null as NodeJS.Signals | null, stderr: '' }
}))

const SILERO_DIR = '/tmp/deskhand-silero-test/silero'
const MODELS_DIR = `${SILERO_DIR}/models`

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/deskhand-silero-test' }
}))

vi.mock('./pronounce', () => ({
  resolvePronunciations: async () => ({})
}))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    existsSync: (path: string) => !state.missing.has(path),
    readFileSync: () => 'v0.5.0\n',
    createWriteStream: () => new PassThrough()
  }
})

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    mkdir: async () => undefined,
    writeFile: async (path: string, data: string | Buffer) => {
      state.written.push({ path, data: String(data) })
      if (path.endsWith('.py')) state.scripts.set(path, String(data))
    },
    readFile: async (path: string) => {
      if (!path.endsWith('.py')) return Buffer.from('RIFF')
      const script = state.scripts.get(path)
      if (script === undefined) throw new Error('ENOENT')
      return script
    },
    rm: async (path: string) => {
      state.removed.push(path)
    },
    rename: async () => undefined
  }
})

vi.mock('node:child_process', () => ({
  spawn: (command: string, args: string[]): ChildProcess => {
    state.spawns.push([command, ...args])
    const worker = args[0].endsWith('worker_tts.py')
    const child = new EventEmitter() as ChildProcess
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    child.stdin = {
      write: (chunk: string): boolean => {
        if (!worker) return true
        const request = JSON.parse(chunk) as { id: number }
        queueMicrotask(() => {
          if (!state.workerAnswers) {
            child.emit('error', new Error('python is missing'))
            return
          }
          stdout.write(`DESKHAND ${JSON.stringify({ id: request.id, ok: true })}\n`)
        })
        return true
      }
    } as ChildProcess['stdin']
    child.stdout = stdout
    child.stderr = stderr
    child.kill = () => true
    if (!worker) {
      queueMicrotask(() => {
        const { code, signal, stderr: text } = state.oneShot
        if (text) stderr.write(text)
        child.emit('close', code, signal)
      })
    }
    return child
  }
}))

beforeEach(() => {
  state.spawns = []
  state.workerAnswers = false
  state.missing.clear()
  state.scripts.clear()
  state.written = []
  state.removed = []
  state.oneShot = { code: 0, signal: null, stderr: '' }
})

afterEach(async () => {
  const { stopSileroWorker } = await import('./silero')
  stopSileroWorker()
  vi.unstubAllGlobals()
  vi.resetModules()
})

describe('Silero synthesis', () => {
  it('keeps the warm worker when it answers and never starts the one-shot', async () => {
    state.workerAnswers = true
    const { synthesizeSilero } = await import('./silero')

    const result = await synthesizeSilero('Готово.', 'xenia', {})

    expect(result.ok).toBe(true)
    expect(state.spawns).toHaveLength(1)
    expect(state.spawns[0][1]).toMatch(/worker_tts\.py$/)
  })

  it('renders with batch_tts.py when the worker cannot start', async () => {
    const { synthesizeSilero } = await import('./silero')

    const result = await synthesizeSilero('Готово.', 'xenia', {})

    expect(result.ok).toBe(true)
    expect(state.spawns).toHaveLength(2)
    expect(state.spawns[0][1]).toMatch(/worker_tts\.py$/)
    expect(state.spawns[1][1]).toMatch(/batch_tts\.py$/)
  })
})

describe('the one-shot renderer failure', () => {
  it('reports the exception line instead of the traceback header', async () => {
    state.oneShot = {
      code: 1,
      signal: null,
      stderr: [
        'Traceback (most recent call last):',
        '  File "batch_tts.py", line 3, in <module>',
        "ModuleNotFoundError: No module named 'silero_onnx'",
        ''
      ].join('\n')
    }
    const { synthesizeSilero } = await import('./silero')

    const result = await synthesizeSilero('Готово.', 'xenia', {})

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.message).toBe("ModuleNotFoundError: No module named 'silero_onnx'")
      expect(result.message).not.toContain('Traceback')
    }
  })

  it('names the signal when the process was killed instead of showing a null code', async () => {
    state.oneShot = { code: null, signal: 'SIGKILL', stderr: '' }
    const { synthesizeSilero } = await import('./silero')

    const result = await synthesizeSilero('Готово.', 'xenia', {})

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.message).toContain('SIGKILL')
      expect(result.message).not.toContain('null')
    }
  })
})

describe('the installed scripts', () => {
  it('rewrites batch_tts.py when its content changed, and only then', async () => {
    const { synthesizeSilero } = await import('./silero')
    const batch = `${SILERO_DIR}/batch_tts.py`

    state.scripts.set(batch, 'old batch script\n')
    await synthesizeSilero('Первый.', 'xenia', {})

    const written = state.written.filter((entry) => entry.path === batch)
    expect(written).toHaveLength(1)
    expect(written[0].data).toContain('synthesize_to_file')

    state.written = []
    state.scripts.set(batch, written[0].data)
    await synthesizeSilero('Второй.', 'xenia', {})

    expect(state.written.filter((entry) => entry.path === batch)).toHaveLength(0)
  })
})

describe('installing the model', () => {
  it('removes the partial file when a download dies halfway', async () => {
    state.missing.add(`${MODELS_DIR}/acoustic_v5_6_ru.onnx`)
    vi.stubGlobal('fetch', async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]))
        controller.error(new Error('сеть пропала'))
      }
    })))

    const { installSilero } = await import('./silero')
    const failure = await installSilero(() => undefined)

    expect(failure).toContain('сеть пропала')
    expect(state.removed).toContain(`${MODELS_DIR}/acoustic_v5_6_ru.onnx.part`)
  })
})
