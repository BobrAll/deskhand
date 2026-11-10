import { Writable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * `whisper.ts` touches the file system, the network, `child_process` and the
 * settings store. All four are mocked: no real whisper, no download, no store.
 */
const state = vi.hoisted(() => ({
  existing: new Set<string>(),
  isPackaged: false,
  appPath: '/app',
  userData: '/userdata',
  /** Directory listing per path. */
  dirs: {} as Record<string, string[]>,
  /** File sizes per path. */
  sizes: {} as Record<string, number>,
  settings: { voice: { model: 'small-q5_1', language: 'ru', enabled: true } },
  spawned: [] as Array<{ binary: string; args: string[] }>,
  /** What the fake whisper process prints and how it ends. */
  whisper: { stdout: '', stderr: '', code: 0 as number | null, emitError: false },
  transcript: '',
  written: [] as Array<{ path: string; data: Buffer }>,
  removed: [] as string[],
  renamed: [] as Array<[string, string]>,
  copied: [] as Array<[string, string]>,
  madeDirs: [] as string[],
  /** Fetch answers, call by call. */
  fetchResponses: [] as Array<() => Promise<Response>>,
  cpuCount: 8,
  tmpdir: '/tmp'
}))

vi.mock('electron', () => ({
  app: {
    get isPackaged() {
      return state.isPackaged
    },
    getAppPath: () => state.appPath,
    getPath: () => state.userData
  }
}))

vi.mock('node:fs', () => ({
  existsSync: (path: string) => state.existing.has(path),
  createWriteStream: () => new Writable({ write: (_chunk, _encoding, done) => done() })
}))

vi.mock('node:fs/promises', () => ({
  readFile: async () => state.transcript,
  readdir: async (path: string) => {
    const entries = state.dirs[path]
    if (!entries) throw new Error(`ENOENT: ${path}`)
    return entries
  },
  stat: async (path: string) => {
    const size = state.sizes[path]
    if (size === undefined) throw new Error(`ENOENT: ${path}`)
    return { size }
  },
  mkdir: async (path: string) => {
    state.madeDirs.push(path)
  },
  writeFile: async (path: string, data: Buffer) => {
    state.written.push({ path, data })
  },
  rm: async (path: string) => {
    state.removed.push(path)
  },
  rename: async (from: string, to: string) => {
    state.renamed.push([from, to])
  },
  copyFile: async (from: string, to: string) => {
    state.copied.push([from, to])
  }
}))

vi.mock('node:os', () => ({
  cpus: () => new Array(state.cpuCount).fill({}),
  homedir: () => '/home/user',
  tmpdir: () => state.tmpdir
}))

vi.mock('node:child_process', () => ({
  spawn: (binary: string, args: string[]) => {
    state.spawned.push({ binary, args })
    const handlers = new Map<string, (value: never) => void>()
    const child = {
      stdout: {
        setEncoding: () => undefined,
        on: (_event: string, handler: (chunk: string) => void) => {
          if (state.whisper.stdout) handler(state.whisper.stdout)
        }
      },
      stderr: {
        setEncoding: () => undefined,
        on: (_event: string, handler: (chunk: string) => void) => {
          if (state.whisper.stderr) handler(state.whisper.stderr)
        }
      },
      kill: () => true,
      on: (event: string, handler: (value: never) => void) => {
        handlers.set(event, handler)
        queueMicrotask(() => {
          if (event === 'error' && state.whisper.emitError) {
            handler(new Error('spawn ENOENT') as never)
            return
          }
          if (event === 'close') handler(state.whisper.code as never)
        })
      }
    }
    return child
  }
}))

vi.mock('../settings/store', () => ({
  getSettings: () => state.settings
}))

type WhisperModule = typeof import('./whisper')

let whisper: WhisperModule

async function load(): Promise<WhisperModule> {
  vi.resetModules()
  return import('./whisper')
}

const WAV = Buffer.from('RIFF....WAVE')

beforeEach(async () => {
  state.existing = new Set()
  state.isPackaged = false
  state.dirs = {}
  state.sizes = {}
  state.settings = { voice: { model: 'small-q5_1', language: 'ru', enabled: true } }
  state.spawned = []
  state.whisper = { stdout: '', stderr: '', code: 0, emitError: false }
  state.transcript = ''
  state.written = []
  state.removed = []
  state.renamed = []
  state.copied = []
  state.madeDirs = []
  state.fetchResponses = []
  state.cpuCount = 8
  vi.stubGlobal('fetch', vi.fn(async () => {
    const next = state.fetchResponses.shift()
    if (!next) throw new Error('unexpected fetch')
    return next()
  }))
  whisper = await load()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('resolveBinary', () => {
  it('prefers the bundled binary', async () => {
    state.existing = new Set(['/app/resources/whisper-cli', '/opt/homebrew/bin/whisper-cli'])

    expect((await load()).resolveBinary()).toBe('/app/resources/whisper-cli')
  })

  it('falls back to a Homebrew install', () => {
    state.existing = new Set(['/usr/local/bin/whisper-cli'])

    expect(whisper.resolveBinary()).toBe('/usr/local/bin/whisper-cli')
  })

  it('returns null when nothing is installed', () => {
    expect(whisper.resolveBinary()).toBeNull()
  })
})

describe('installedModels', () => {
  it('reports the catalog ids whose files are on disk', async () => {
    state.dirs['/userdata/models'] = ['ggml-base.bin', 'ggml-small-q5_1.bin', 'ggml-custom.bin', 'notes.txt']

    expect(await whisper.installedModels()).toEqual(['base', 'small-q5_1', 'ggml-custom.bin'])
  })

  it('returns an empty list when the directory does not exist yet', async () => {
    expect(await whisper.installedModels()).toEqual([])
  })
})

describe('resolveModel', () => {
  it('uses the configured model from the app directory', async () => {
    state.existing = new Set(['/userdata/models/ggml-small-q5_1.bin'])

    expect(await whisper.resolveModel()).toEqual({
      path: '/userdata/models/ggml-small-q5_1.bin',
      auto: false
    })
  })

  it('falls back to the same model elsewhere on disk and flags it as auto', async () => {
    state.existing = new Set(['/opt/homebrew/share/whisper.cpp/models/ggml-small-q5_1.bin'])

    expect(await whisper.resolveModel()).toEqual({
      path: '/opt/homebrew/share/whisper.cpp/models/ggml-small-q5_1.bin',
      auto: true
    })
  })

  it('picks the largest model found when the configured one is missing', async () => {
    state.dirs['/userdata/models'] = ['ggml-tiny.bin', 'ggml-large-v3-turbo-q5_0.bin']
    state.sizes['/userdata/models/ggml-tiny.bin'] = 100
    state.sizes['/userdata/models/ggml-large-v3-turbo-q5_0.bin'] = 900

    expect(await whisper.resolveModel()).toEqual({
      path: '/userdata/models/ggml-large-v3-turbo-q5_0.bin',
      auto: true
    })
  })

  it('ignores files that are not `ggml-*.bin`', async () => {
    state.dirs['/userdata/models'] = ['ggml-x.bin.part', 'other.bin', 'ggml-ok.bin']
    state.sizes['/userdata/models/ggml-ok.bin'] = 10

    expect((await whisper.resolveModel()).path).toBe('/userdata/models/ggml-ok.bin')
  })

  it('returns null when nothing is on disk', async () => {
    expect(await whisper.resolveModel()).toEqual({ path: null, auto: true })
  })
})

describe('voiceStatus', () => {
  it('is ready when both the binary and a model are present', async () => {
    state.existing = new Set(['/app/resources/whisper-cli', '/userdata/models/ggml-small-q5_1.bin'])
    state.dirs['/userdata/models'] = ['ggml-small-q5_1.bin']

    const status = await whisper.voiceStatus()

    expect(status.ready).toBe(true)
    expect(status.enabled).toBe(true)
    expect(status.detail).toBeNull()
    expect(status.modelsDir).toBe('/userdata/models')
    expect(status.installed).toEqual(['small-q5_1'])
    expect(status.listenerError).toBeNull()
  })

  it('reports the feature switch separately from the install state', async () => {
    state.existing = new Set(['/app/resources/whisper-cli', '/userdata/models/ggml-small-q5_1.bin'])
    state.dirs['/userdata/models'] = ['ggml-small-q5_1.bin']
    state.settings.voice.enabled = false

    const status = await whisper.voiceStatus()

    // Ready means "could work"; enabled is whether the user wants it to. The
    // overlay warms the microphone only for the second.
    expect(status.ready).toBe(true)
    expect(status.enabled).toBe(false)
  })

  it('explains a missing binary', async () => {
    const status = await whisper.voiceStatus()

    expect(status.ready).toBe(false)
    expect(status.detail).toBe(
      'Не найден whisper-cli — пересоберите приложение (npm run build:whisper).'
    )
  })

  it('explains a missing model when the binary is there', async () => {
    state.existing = new Set(['/app/resources/whisper-cli'])

    const status = await whisper.voiceStatus()

    expect(status.ready).toBe(false)
    expect(status.detail).toBe('Не скачана модель распознавания — выберите её в настройках.')
  })
})

describe('transcribe', () => {
  function ready(): void {
    state.existing = new Set(['/app/resources/whisper-cli', '/userdata/models/ggml-small-q5_1.bin'])
  }

  it('runs the selected GigaAM model in Russian and reads only its transcript file', async () => {
    state.settings.voice = { model: 'gigaam-v3-e2e-rnnt', language: 'en', enabled: true }
    const binary = '/app/resources/transcribe-cli'
    const model = '/userdata/models/gigaam-v3-e2e-rnnt-Q4_K_M.gguf'
    state.existing = new Set([binary, model])
    state.whisper.stdout = 'run: ok\ntext: Открой настройки.'
    state.transcript = 'Открой настройки.'

    expect(await whisper.transcribe({ wav: WAV })).toMatchObject({
      ok: true,
      text: state.transcript
    })
    expect(state.spawned).toEqual([{
      binary,
      args: ['-m', model, '-l', 'ru', '--timestamps', 'none', '-o', expect.any(String), expect.any(String)]
    }])
  })

  it('requires the selected GigaAM weights even when Whisper weights are installed', async () => {
    state.settings.voice.model = 'gigaam-v3-e2e-rnnt'
    state.existing.add('/app/resources/transcribe-cli')
    state.dirs['/userdata/models'] = ['ggml-small-q5_1.bin']
    state.sizes['/userdata/models/ggml-small-q5_1.bin'] = 181
    expect(await whisper.voiceStatus()).toMatchObject({ ready: false, modelPath: null })
  })

  it('fails cleanly when whisper-cli is missing', async () => {
    expect(await whisper.transcribe({ wav: WAV })).toEqual({
      ok: false,
      text: '',
      ms: 0,
      message: 'Не найден whisper-cli.'
    })
  })

  it('fails cleanly when no model is installed', async () => {
    state.existing = new Set(['/app/resources/whisper-cli'])

    expect(await whisper.transcribe({ wav: WAV })).toEqual({
      ok: false,
      text: '',
      ms: 0,
      message: 'Не скачана модель распознавания.'
    })
  })

  it('passes the exact whisper arguments', async () => {
    ready()
    state.whisper.stdout = 'привет'

    await whisper.transcribe({ wav: WAV })

    const args = state.spawned[0].args
    expect(state.spawned[0].binary).toBe('/app/resources/whisper-cli')
    expect(args.slice(0, 2)).toEqual(['-m', '/userdata/models/ggml-small-q5_1.bin'])
    expect(args[2]).toBe('-f')
    expect(args[3]).toMatch(/^\/tmp\/deskhand-voice-.+\/input\.wav$/)
    expect(args.slice(4, 8)).toEqual(['-l', 'ru', '-nt', '-np'])
    expect(args[8]).toBe('-t')
  })

  it('writes the WAV to a temp file and removes the directory afterwards', async () => {
    ready()
    state.whisper.stdout = 'привет'

    await whisper.transcribe({ wav: WAV })

    expect(state.written).toHaveLength(1)
    expect(state.written[0].data).toBe(WAV)
    expect(state.removed).toHaveLength(1)
    expect(state.removed[0]).toMatch(/^\/tmp\/deskhand-voice-/)
  })

  it('uses the configured language, and `ru` when it is blank', async () => {
    ready()
    state.whisper.stdout = 'x'
    await whisper.transcribe({ wav: WAV })
    expect(state.spawned[0].args[5]).toBe('ru')

    state.settings = { voice: { model: 'small-q5_1', language: '', enabled: true } }
    await whisper.transcribe({ wav: WAV })
    expect(state.spawned[1].args[5]).toBe('ru')

    state.settings = { voice: { model: 'small-q5_1', language: 'en', enabled: true } }
    await whisper.transcribe({ wav: WAV })
    expect(state.spawned[2].args[5]).toBe('en')
  })

  it('computes the thread count from the cores, clamped to 2..8', async () => {
    ready()
    state.whisper.stdout = 'x'

    for (const [cores, expected] of [
      [1, '2'],
      [8, '4'],
      [12, '6'],
      [32, '8']
    ] as Array<[number, string]>) {
      state.cpuCount = cores
      await whisper.transcribe({ wav: WAV })
      expect(state.spawned[state.spawned.length - 1].args[9], String(cores)).toBe(expected)
    }
  })

  it('strips timestamps and joins the lines', async () => {
    ready()
    state.whisper.stdout = '[00:00:00.000 --> 00:00:02.000]  открой\n[00:00:02.000 --> 00:00:04.000]  настройки\n'

    expect(await whisper.transcribe({ wav: WAV })).toMatchObject({
      ok: true,
      text: 'открой настройки'
    })
  })

  it('drops whisper artefacts for silence', async () => {
    ready()
    state.whisper.stdout = '[00:00:00.000 --> 00:00:02.000] (music)\n(Music)\n[BLANK_AUDIO]\nтишина\n'

    expect((await whisper.transcribe({ wav: WAV })).text).toBe('тишина')
  })

  it('reports silence as a failure, not as an empty answer', async () => {
    ready()
    state.whisper.stdout = '(music)\n[BLANK_AUDIO]\n'

    expect(await whisper.transcribe({ wav: WAV })).toMatchObject({
      ok: false,
      text: '',
      message: 'Речь не распознана — попробуйте ещё раз.'
    })
  })

  it('reports a non-zero exit with the first stderr line', async () => {
    ready()
    state.whisper = { stdout: '', stderr: '\n  failed to load model  \nmore', code: 2, emitError: false }

    expect(await whisper.transcribe({ wav: WAV })).toMatchObject({
      ok: false,
      message: 'failed to load model'
    })
  })

  it('falls back to the exit code when stderr is empty', async () => {
    ready()
    state.whisper = { stdout: '', stderr: '', code: 3, emitError: false }

    expect((await whisper.transcribe({ wav: WAV })).message).toBe(
      'whisper-cli завершился с кодом 3.'
    )
  })

  it('accepts a non-zero exit when whisper printed a transcript anyway', async () => {
    ready()
    state.whisper = { stdout: 'текст', stderr: '', code: 1, emitError: false }

    expect(await whisper.transcribe({ wav: WAV })).toMatchObject({ ok: true, text: 'текст' })
  })

  it('reports a spawn error', async () => {
    ready()
    state.whisper = { stdout: '', stderr: '', code: null, emitError: true }

    expect(await whisper.transcribe({ wav: WAV })).toMatchObject({
      ok: false,
      message: 'spawn ENOENT'
    })
  })

  it('reports an abort as cancelled, and still removes the temp directory', async () => {
    ready()
    state.whisper.stdout = 'поздно'
    const controller = new AbortController()
    controller.abort()

    const result = await whisper.transcribe({ wav: WAV, signal: controller.signal })

    expect(result).toMatchObject({ ok: false, text: '', message: 'Отменено.' })
    expect(state.removed).toHaveLength(1)
  })

  it('reports the elapsed milliseconds', async () => {
    ready()
    state.whisper.stdout = 'текст'

    const result = await whisper.transcribe({ wav: WAV })

    expect(result.ms).toBeGreaterThanOrEqual(0)
  })
})

describe('downloadModel', () => {
  function bodyOf(text: string): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder()
    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(text))
        controller.close()
      }
    })
  }

  it('rejects an unknown model id', async () => {
    await expect(whisper.downloadModel('nope', () => undefined)).rejects.toThrow('unknown-model')
  })

  it('downloads into a `.part` file and renames it when complete', async () => {
    state.fetchResponses = [
      async () => new Response(bodyOf('model-bytes'), { status: 200 })
    ]
    const progress: Array<{ done: boolean; received: number }> = []

    await whisper.downloadModel('tiny', (event) => progress.push(event))

    expect(state.renamed).toEqual([
      ['/userdata/models/ggml-tiny.bin.part', '/userdata/models/ggml-tiny.bin']
    ])
    expect(progress.at(-1)).toMatchObject({ done: true })
  })

  it('requests the catalog URL', async () => {
    state.fetchResponses = [async () => new Response(bodyOf('x'), { status: 200 })]

    await whisper.downloadModel('tiny', () => undefined)

    const url = (globalThis.fetch as unknown as { mock: { calls: string[][] } }).mock.calls[0][0]
    expect(url).toBe(
      'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin'
    )
  })

  it('reports an HTTP failure, removes the part file and rethrows', async () => {
    state.fetchResponses = [async () => new Response('nope', { status: 404 })]
    const progress: Array<{ error?: string }> = []

    await expect(
      whisper.downloadModel('tiny', (event) => progress.push(event))
    ).rejects.toThrow('HTTP 404')
    expect(state.removed).toContain('/userdata/models/ggml-tiny.bin.part')
    expect(progress.at(-1)?.error).toBe('HTTP 404')
  })

  it('aborts an unresponsive server and allows a retry', async () => {
    vi.useFakeTimers()
    try {
      vi.mocked(fetch).mockImplementationOnce(async (_url, init) => {
        const signal = init?.signal
        return new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
        })
      })
      const report = vi.fn()
      const task = whisper.downloadModel('tiny', report)
      const failure = expect(task).rejects.toThrow('Сервер загрузки модели не отвечает')

      await vi.advanceTimersByTimeAsync(30_000)
      await failure
      expect(report).toHaveBeenLastCalledWith(expect.objectContaining({
        done: true,
        error: expect.stringContaining('Сервер загрузки модели не отвечает')
      }))
      expect(whisper.isDownloading('tiny')).toBe(false)
      expect(state.renamed).toHaveLength(0)

      state.fetchResponses = [async () => new Response(bodyOf('model'), { status: 200 })]
      await whisper.downloadModel('tiny', report)
      expect(state.renamed).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('returns the same promise for a model that is already downloading', async () => {
    let release = (): void => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    state.fetchResponses = [
      async () => {
        await gate
        return new Response(bodyOf('x'), { status: 200 })
      }
    ]

    const first = whisper.downloadModel('tiny', () => undefined)
    const second = whisper.downloadModel('tiny', () => undefined)

    expect(whisper.isDownloading('tiny')).toBe(true)
    expect(first).toBe(second)
    release()
    await first
    expect(whisper.isDownloading('tiny')).toBe(false)
  })
})

describe('deleteModel', () => {
  it('removes catalog and imported files from the app models directory', async () => {
    await whisper.deleteModel('gigaam-v3-e2e-rnnt')
    await whisper.deleteModel('ggml-custom.bin')

    expect(state.removed).toEqual([
      '/userdata/models/gigaam-v3-e2e-rnnt-Q4_K_M.gguf',
      '/userdata/models/ggml-custom.bin'
    ])
  })

  it('rejects paths and unrelated filenames', async () => {
    for (const id of ['ggml-x/../../ggml-base.bin', '/tmp/ggml-base.bin', 'notes.txt']) {
      await expect(whisper.deleteModel(id)).rejects.toThrow('Неизвестная модель')
    }
    expect(state.removed).toEqual([])
  })
})

describe('importModel', () => {
  it('copies a `ggml-*.bin` into the models directory', async () => {
    const id = await whisper.importModel('/Downloads/ggml-base.bin')

    expect(id).toBe('base')
    expect(state.copied).toEqual([['/Downloads/ggml-base.bin', '/userdata/models/ggml-base.bin']])
  })

  it('returns the file name for a model that is not in the catalog', async () => {
    expect(await whisper.importModel('/Downloads/ggml-custom.bin')).toBe('ggml-custom.bin')
  })

  it('rejects a file that is not a whisper model', async () => {
    await expect(whisper.importModel('/Downloads/model.bin')).rejects.toThrow(
      'Нужен файл модели whisper: ggml-*.bin.'
    )
    expect(state.copied).toHaveLength(0)
  })
})
