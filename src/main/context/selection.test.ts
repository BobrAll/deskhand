import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The polling loop in `readSelection` is a busy-wait on `Date.now()` (RULES.md:
 * do not rewrite it). Fake timers that replace `Date` would hang it forever, so
 * the clock is a plain spy that advances 35 ms per read, and `delay` is mocked.
 */
const state = vi.hoisted(() => ({
  /** What `clipboard.readText()` answers, call by call. */
  reads: [] as string[],
  lastRead: '',
  cleared: 0,
  /** The clipboard calls, in order. */
  order: [] as string[]
}))

vi.mock('electron', () => ({
  clipboard: {
    clear: () => {
      state.cleared += 1
      state.lastRead = ''
      state.order.push('clear')
    },
    readText: () => {
      state.order.push('readText')
      const next = state.reads.length > 0 ? state.reads.shift() : state.lastRead
      state.lastRead = next ?? ''
      return state.lastRead
    }
  }
}))

const { helperSendKey } = vi.hoisted(() => ({ helperSendKey: vi.fn() }))

vi.mock('../native/helper', () => ({ helperSendKey }))

const { snapshotClipboard, restoreClipboard, withClipboard } = vi.hoisted(() => ({
  snapshotClipboard: vi.fn(),
  restoreClipboard: vi.fn(),
  withClipboard: vi.fn()
}))

vi.mock('../paste/clipboard', () => ({ snapshotClipboard, restoreClipboard, withClipboard }))

const { delay } = vi.hoisted(() => ({ delay: vi.fn() }))

vi.mock('../util', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../util')>()
  return { ...actual, delay }
})

import { MAX_SELECTION_CHARS, readSelection } from './selection'

const snapshot = { text: 'старый буфер', html: '', rtf: '', bookmark: null, png: null }

/** A clock that moves 35 ms forward on every read, so the 450 ms loop ends. */
function advancingClock(): void {
  let now = 1_000_000
  vi.spyOn(Date, 'now').mockImplementation(() => {
    now += 35
    return now
  })
}

beforeEach(() => {
  state.reads = []
  state.lastRead = ''
  state.cleared = 0
  state.order = []
  helperSendKey.mockReset().mockResolvedValue(true)
  snapshotClipboard.mockReset().mockReturnValue(snapshot)
  restoreClipboard.mockReset()
  delay.mockReset().mockResolvedValue(undefined)
  withClipboard.mockReset().mockImplementation((task: () => Promise<unknown>) => task())
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('readSelection: the happy path', () => {
  it('runs the task through the clipboard queue', async () => {
    state.reads = ['выделенный текст']

    await readSelection()

    expect(withClipboard).toHaveBeenCalledTimes(1)
  })

  it('returns the captured text', async () => {
    state.reads = ['выделенный текст']

    expect(await readSelection()).toEqual({ text: 'выделенный текст', truncated: false })
  })

  it('clears the pasteboard before asking for a copy', async () => {
    state.reads = ['текст']

    await readSelection()

    expect(state.order[0]).toBe('clear')
    expect(helperSendKey).toHaveBeenCalledWith('copy')
  })

  it('restores the previous clipboard content', async () => {
    state.reads = ['текст']

    await readSelection()

    expect(restoreClipboard).toHaveBeenCalledWith(snapshot)
  })

  it('keeps polling until text appears', async () => {
    state.reads = ['', '', 'поздний текст']

    expect(await readSelection()).toEqual({ text: 'поздний текст', truncated: false })
    expect(delay).toHaveBeenCalledTimes(3)
  })
})

describe('readSelection: no selection', () => {
  it('returns null when the copy key could not be sent, and still restores', async () => {
    helperSendKey.mockResolvedValue(false)

    expect(await readSelection()).toBeNull()
    expect(restoreClipboard).toHaveBeenCalledWith(snapshot)
  })

  it('gives up after the 450 ms deadline when nothing ever appears', async () => {
    advancingClock()
    state.reads = []

    expect(await readSelection()).toBeNull()
    // 450 / 35 ≈ 13 polls, each one a 35 ms delay.
    expect(delay.mock.calls.length).toBeGreaterThan(10)
    expect(delay.mock.calls.length).toBeLessThan(20)
    expect(restoreClipboard).toHaveBeenCalledWith(snapshot)
  })

  it('treats a whitespace-only capture as no selection', async () => {
    state.reads = ['   \n\t ']

    expect(await readSelection()).toBeNull()
  })
})

describe('readSelection: the size limit', () => {
  it('truncates a long selection at 24 000 characters', async () => {
    state.reads = ['я'.repeat(MAX_SELECTION_CHARS + 10)]

    const selection = await readSelection()

    expect(selection?.text).toHaveLength(MAX_SELECTION_CHARS)
    expect(selection?.truncated).toBe(true)
  })

  it('keeps a selection of exactly the limit untruncated', async () => {
    state.reads = ['я'.repeat(MAX_SELECTION_CHARS)]

    const selection = await readSelection()

    expect(selection?.text).toHaveLength(MAX_SELECTION_CHARS)
    expect(selection?.truncated).toBe(false)
  })
})
