import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '@shared/defaults'
import type { AppSettings } from '@shared/types'
import type { ChatMessage } from '../llm/provider'

const fake = vi.hoisted(() => ({
  settings: {} as AppSettings,
  key: 'sk-test' as string | null,
  model: 'chat-model',
  calls: [] as ChatMessage[][],
  reply: '{}',
  fail: false,
  hang: false,
  gate: null as Promise<void> | null,
  files: new Map<string, string>()
}))

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/deskhand-pronounce-test' }
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    mkdir: async () => undefined,
    readFile: async (path: string) => {
      const hit = fake.files.get(path)
      if (!hit) throw new Error('ENOENT')
      return hit
    },
    writeFile: async (path: string, data: string) => {
      fake.files.set(path, data)
    },
    rename: async (from: string, to: string) => {
      const data = fake.files.get(from)
      if (data === undefined) throw new Error('ENOENT')
      fake.files.delete(from)
      fake.files.set(to, data)
    },
    rm: async (path: string) => {
      fake.files.delete(path)
    }
  }
})

vi.mock('../llm', () => ({
  getProvider: () => ({
    id: 'openai',
    async *stream(messages: ChatMessage[]) {
      fake.calls.push(messages)
      if (fake.fail) throw new Error('provider down')
      if (fake.hang) {
        await new Promise(() => {})
        return
      }
      if (fake.gate) await fake.gate
      yield { delta: fake.reply }
    }
  }),
  resolveChatModel: () => fake.model
}))

vi.mock('../settings/store', () => ({ getSettings: () => fake.settings }))
vi.mock('../settings/secrets', () => ({ getApiKey: () => fake.key }))

function settings(): AppSettings {
  return {
    ...DEFAULT_SETTINGS,
    tts: { ...DEFAULT_SETTINGS.tts, engine: 'silero', pronunciationLookup: true }
  }
}

async function resolve(text: string): Promise<Record<string, string>> {
  const module = await import('./pronounce')
  return module.resolvePronunciations(text)
}

async function prefetch(text: string): Promise<void> {
  const module = await import('./pronounce')
  await module.prefetchHints(text)
}

beforeEach(() => {
  fake.settings = settings()
  fake.key = 'sk-test'
  fake.model = 'chat-model'
  fake.calls = []
  fake.reply = '{}'
  fake.fail = false
  fake.hang = false
  fake.gate = null
  fake.files.clear()
  vi.resetModules()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('resolvePronunciations', () => {
  it('asks the model only for the words the dictionary does not know', async () => {
    fake.reply = JSON.stringify({ localhost: 'локалх+ост', unrelated: 'анрел+ейтед' })

    const hints = await resolve('Открой README и проверь localhost.')

    expect(hints).toEqual({ localhost: 'локалх+ост' })
    expect(fake.calls).toHaveLength(1)
    const sent = fake.calls[0][1].parts[0]
    expect(sent).toEqual({ type: 'text', text: '["localhost"]' })
    expect([...fake.files.values()].join('')).not.toContain('unrelated')
  })

  it('writes the hint to the cache and uses it on the next call, even without a key', async () => {
    fake.reply = JSON.stringify({ localhost: 'локалх+ост' })
    await resolve('localhost')
    expect(fake.calls).toHaveLength(1)

    vi.resetModules()
    fake.calls = []
    fake.key = null
    const hints = await resolve('localhost')

    expect(hints).toEqual({ localhost: 'локалх+ост' })
    expect(fake.calls).toHaveLength(0)
    expect([...fake.files.values()].join('')).toContain('локалх+ост')
  })

  it('drops a hint the voice cannot read and keeps the valid ones', async () => {
    fake.reply = JSON.stringify({ localhost: 'локалх+ост', widget: 'виджет' })

    const hints = await resolve('localhost widget')

    expect(hints).toEqual({ localhost: 'локалх+ост' })
  })

  it('accepts a hint the model punctuated like a sentence', async () => {
    fake.reply = JSON.stringify({ localhost: 'локалх+ост.' })

    await expect(resolve('localhost')).resolves.toEqual({ localhost: 'локалх+ост' })
  })

  it('writes the cache through a temporary file and renames it into place', async () => {
    fake.reply = JSON.stringify({ localhost: 'локалх+ост' })

    await resolve('localhost')

    const target = '/tmp/deskhand-pronounce-test/tts-pronunciation.json'
    expect(fake.files.has(`${target}.part`)).toBe(false)
    expect(fake.files.get(target)).toContain('локалх+ост')
  })

  it('does not ask when the user turned the lookup off', async () => {
    fake.settings = { ...fake.settings, tts: { ...fake.settings.tts, pronunciationLookup: false } }

    expect(await resolve('localhost')).toEqual({})
    expect(fake.calls).toHaveLength(0)
  })

  it('does not ask without a chat key or model', async () => {
    fake.key = null
    expect(await resolve('localhost')).toEqual({})

    fake.key = 'sk-test'
    fake.model = ''
    expect(await resolve('localhost')).toEqual({})
    expect(fake.calls).toHaveLength(0)
  })

  it('stays silent when the provider fails', async () => {
    fake.fail = true
    expect(await resolve('localhost')).toEqual({})
  })

  it('shares one lookup between lines that need the same word', async () => {
    let release!: () => void
    fake.gate = new Promise<void>((resolve) => {
      release = resolve
    })
    fake.reply = JSON.stringify({ localhost: 'локалх+ост' })
    const { resolvePronunciations } = await import('./pronounce')

    const first = resolvePronunciations('localhost')
    const second = resolvePronunciations('localhost')
    await vi.waitFor(() => expect(fake.calls).toHaveLength(1))
    expect(fake.calls).toHaveLength(1)

    release()
    await expect(first).resolves.toEqual({ localhost: 'локалх+ост' })
    await expect(second).resolves.toEqual({ localhost: 'локалх+ост' })
  })

  it('does not pay the wait again while a lookup is unresponsive, until the provider changes', async () => {
    vi.useFakeTimers()
    let release!: () => void
    fake.gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const { resolvePronunciations } = await import('./pronounce')

    const first = resolvePronunciations('localhost')
    await vi.advanceTimersByTimeAsync(800)
    await expect(first).resolves.toEqual({})
    const calls = fake.calls.length
    await expect(resolvePronunciations('localhost')).resolves.toEqual({})
    expect(fake.calls).toHaveLength(calls)

    release()
    await vi.advanceTimersByTimeAsync(0)

    // A configuration change resets the backoff immediately.
    fake.model = 'faster-model'
    fake.reply = JSON.stringify({ localhost: 'локалх+ост' })
    await expect(resolvePronunciations('localhost')).resolves.toEqual({ localhost: 'локалх+ост' })
  })

  it('starts a fresh request when the key rotates during a stalled lookup', async () => {
    let releaseFirst!: () => void
    fake.gate = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const { resolvePronunciations } = await import('./pronounce')

    const first = resolvePronunciations('localhost')
    await vi.waitFor(() => expect(fake.calls).toHaveLength(1))

    fake.key = 'sk-other'
    fake.gate = null
    fake.reply = JSON.stringify({ localhost: 'локалх+ост' })
    const second = resolvePronunciations('localhost')
    await vi.waitFor(() => expect(fake.calls).toHaveLength(2))
    await expect(second).resolves.toEqual({ localhost: 'локалх+ост' })

    releaseFirst()
    await first
  })

  it('asks for a word that arrived during another lookup once that lookup settles', async () => {
    const target = '/tmp/deskhand-pronounce-test/tts-pronunciation.json'
    let release!: () => void
    fake.gate = new Promise<void>((resolve) => {
      release = resolve
    })
    fake.reply = JSON.stringify({ foo: 'ф+у', bar: 'б+ар' })
    const { resolvePronunciations } = await import('./pronounce')

    const first = resolvePronunciations('foo')
    await vi.waitFor(() => expect(fake.calls).toHaveLength(1))

    // `bar` is not part of the running request, so this line uses the rules at
    // once instead of attaching itself to a lookup that cannot answer for it.
    const second = resolvePronunciations('bar')
    const third = resolvePronunciations('bar')
    await expect(second).resolves.toEqual({})
    await expect(third).resolves.toEqual({})
    expect(fake.calls).toHaveLength(1)

    release()
    await expect(first).resolves.toEqual({ foo: 'ф+у' })

    // The words queued behind the first lookup are asked for once, together.
    await vi.waitFor(() => expect(fake.calls).toHaveLength(2))
    expect(fake.calls[1][1].parts[0]).toEqual({ type: 'text', text: '["bar"]' })
    await vi.waitFor(() => expect(fake.files.get(target)).toContain('б+ар'))

    // The next line gets the hint from the cache, without a request of its own.
    await expect(resolvePronunciations('bar')).resolves.toEqual({ bar: 'б+ар' })
    expect(fake.calls).toHaveLength(2)
  })

  it('does not queue a word the cache already has', async () => {
    const target = '/tmp/deskhand-pronounce-test/tts-pronunciation.json'
    fake.files.set(target, JSON.stringify({ version: 1, words: { bar: 'б+ар' } }))
    let release!: () => void
    fake.gate = new Promise<void>((resolve) => {
      release = resolve
    })
    fake.reply = JSON.stringify({ foo: 'ф+у', baz: 'б+аз' })
    const { resolvePronunciations } = await import('./pronounce')

    const first = resolvePronunciations('foo')
    await vi.waitFor(() => expect(fake.calls).toHaveLength(1))

    await expect(resolvePronunciations('bar baz')).resolves.toEqual({ bar: 'б+ар' })
    expect(fake.calls).toHaveLength(1)

    release()
    await expect(first).resolves.toEqual({ foo: 'ф+у' })

    await vi.waitFor(() => expect(fake.calls).toHaveLength(2))
    expect(fake.calls[1][1].parts[0]).toEqual({ type: 'text', text: '["baz"]' })
  })

  it('keeps queued words unasked while the lookup is backing off', async () => {
    vi.useFakeTimers()
    let release!: () => void
    fake.gate = new Promise<void>((resolve) => {
      release = resolve
    })
    fake.reply = '{}'
    const { resolvePronunciations } = await import('./pronounce')

    const first = resolvePronunciations('foo')
    await vi.advanceTimersByTimeAsync(0)
    expect(fake.calls).toHaveLength(1)

    // `bar` is queued behind a request that never answers in time.
    await expect(resolvePronunciations('bar')).resolves.toEqual({})
    await vi.advanceTimersByTimeAsync(800)
    await expect(first).resolves.toEqual({})

    release()
    await vi.advanceTimersByTimeAsync(0)

    expect(fake.calls).toHaveLength(1)
    await expect(resolvePronunciations('bar')).resolves.toEqual({})
    expect(fake.calls).toHaveLength(1)
  })

  it('survives a background lookup that fails', async () => {
    let release!: () => void
    fake.gate = new Promise<void>((resolve) => {
      release = resolve
    })
    fake.reply = JSON.stringify({ foo: 'ф+у', bar: 'б+ар' })
    const { resolvePronunciations } = await import('./pronounce')

    const first = resolvePronunciations('foo')
    await vi.waitFor(() => expect(fake.calls).toHaveLength(1))
    await expect(resolvePronunciations('bar')).resolves.toEqual({})

    fake.fail = true
    release()
    await expect(first).resolves.toEqual({ foo: 'ф+у' })
    await vi.waitFor(() => expect(fake.calls).toHaveLength(2))

    // The failed retry cached nothing and did not poison the next line.
    await expect(resolvePronunciations('bar')).resolves.toEqual({})
    expect(fake.calls).toHaveLength(3)
  })
})

describe('prefetchHints', () => {
  const target = '/tmp/deskhand-pronounce-test/tts-pronunciation.json'

  it('starts the lookup without waiting for its answer', async () => {
    let release!: () => void
    fake.gate = new Promise<void>((resolve) => {
      release = resolve
    })
    fake.reply = JSON.stringify({ localhost: 'локалх+ост' })

    await prefetch('localhost')
    expect(fake.calls).toHaveLength(1)
    expect(fake.files.get(target)).toBeUndefined()

    release()
    await vi.waitFor(() => expect(fake.files.get(target)).toContain('локалх+ост'))
  })

  it('does not ask for a word the cache already has', async () => {
    fake.files.set(target, JSON.stringify({ version: 1, words: { bar: 'б+ар' } }))

    await prefetch('bar')
    expect(fake.calls).toHaveLength(0)
  })

  it('stays silent without a key, with the lookup off or on a remote engine', async () => {
    fake.key = null
    await prefetch('localhost')

    fake.key = 'sk-test'
    fake.settings = { ...fake.settings, tts: { ...fake.settings.tts, pronunciationLookup: false } }
    await prefetch('localhost')

    fake.settings = {
      ...fake.settings,
      tts: { ...fake.settings.tts, pronunciationLookup: true, engine: 'remote' }
    }
    await prefetch('localhost')

    expect(fake.calls).toHaveLength(0)
  })

  it('queues a word behind the running lookup instead of starting a second one', async () => {
    let release!: () => void
    fake.gate = new Promise<void>((resolve) => {
      release = resolve
    })
    fake.reply = JSON.stringify({ foo: 'ф+у', bar: 'б+ар' })

    await prefetch('foo')
    await vi.waitFor(() => expect(fake.calls).toHaveLength(1))

    await prefetch('bar')
    expect(fake.calls).toHaveLength(1)

    release()
    await vi.waitFor(() => expect(fake.calls).toHaveLength(2))
    expect(fake.calls[1][1].parts[0]).toEqual({ type: 'text', text: '["bar"]' })
    await vi.waitFor(() => expect(fake.files.get(target)).toContain('б+ар'))
  })
})

describe('validPronunciation', () => {
  it('accepts one stress mark before a vowel', async () => {
    const { validPronunciation } = await import('./pronounce')
    expect(validPronunciation('локалх+ост')).toBe(true)
    expect(validPronunciation('сл+ово')).toBe(true)
    expect(validPronunciation('слов+о')).toBe(true)
  })

  it('rejects a multi-vowel word without a mark, two marks or a mark on a consonant', async () => {
    const { validPronunciation } = await import('./pronounce')
    expect(validPronunciation('локалхост')).toBe(false)
    expect(validPronunciation('с+ло+во')).toBe(false)
    expect(validPronunciation('+слово')).toBe(false)
    expect(validPronunciation('localhost')).toBe(false)
  })
})
