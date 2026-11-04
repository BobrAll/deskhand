import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ActiveAppInfo } from '@shared/types'

/** Every clipboard and helper interaction, in the order it happened. */
const state = vi.hoisted(() => ({
  order: [] as string[],
  /** What `waitFor` should answer, call by call. */
  waitForAnswers: [] as boolean[],
  waitForCalls: [] as Array<{ timeoutMs: number; intervalMs: number | undefined }>
}))

vi.mock('electron', () => ({
  clipboard: {
    clear: () => state.order.push('clipboard.clear'),
    writeText: (text: string) => state.order.push(`clipboard.writeText:${text}`),
    readText: () => '',
    readHTML: () => '',
    readRTF: () => '',
    readBookmark: () => ({ title: '', url: '' }),
    has: () => false,
    readImage: () => ({ toPNG: () => Buffer.alloc(0) }),
    write: () => undefined,
    writeImage: () => undefined,
    writeBookmark: () => undefined
  },
  nativeImage: { createFromBuffer: () => ({}) }
}))

const { helperActivate, helperFront, helperSendKey } = vi.hoisted(() => ({
  helperActivate: vi.fn(),
  helperFront: vi.fn(),
  helperSendKey: vi.fn()
}))

vi.mock('../native/helper', () => ({ helperActivate, helperFront, helperSendKey }))

const { snapshotClipboard, restoreClipboard, withClipboard } = vi.hoisted(() => ({
  snapshotClipboard: vi.fn(),
  restoreClipboard: vi.fn(),
  withClipboard: vi.fn()
}))

vi.mock('./clipboard', () => ({
  snapshotClipboard,
  restoreClipboard,
  withClipboard,
  copyText: vi.fn()
}))

const { delay, waitFor } = vi.hoisted(() => ({ delay: vi.fn(), waitFor: vi.fn() }))

vi.mock('../util', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../util')>()
  return { ...actual, delay, waitFor }
})

import { pasteAnswer } from './index'

const target: ActiveAppInfo = {
  bundleId: 'com.apple.TextEdit',
  name: 'TextEdit',
  pid: 900,
  windowTitle: 'Заметка',
  windowId: 3,
  bounds: null
}

const snapshot = { text: 'прежний буфер', html: '', rtf: '', bookmark: null, png: null }

beforeEach(() => {
  state.order = []
  state.waitForAnswers = []
  state.waitForCalls = []
  helperActivate.mockReset().mockResolvedValue(true)
  helperFront.mockReset().mockResolvedValue({ bundleId: 'com.apple.TextEdit', pid: 900 })
  helperSendKey.mockReset().mockResolvedValue(true)
  snapshotClipboard.mockReset().mockReturnValue(snapshot)
  restoreClipboard.mockReset().mockImplementation(() => state.order.push('restoreClipboard'))
  delay.mockReset().mockImplementation(async (ms: number) => {
    state.order.push(`delay:${ms}`)
  })
  waitFor.mockReset().mockImplementation(
    async (check: () => Promise<boolean>, timeoutMs: number, intervalMs?: number) => {
      state.waitForCalls.push({ timeoutMs, intervalMs })
      // Run the real check once instead of polling: the loop itself is `util.ts`.
      const forced = state.waitForAnswers.shift()
      if (forced !== undefined) return forced
      return Boolean(await check())
    }
  )
  // The queue runs the task at once, so the recorded order is the real order.
  withClipboard.mockReset().mockImplementation(async (task: () => Promise<unknown>) => task())
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('pasteAnswer: the order of the calls', () => {
  it('activates the target, pastes, then restores the clipboard', async () => {
    const result = await pasteAnswer('ответ', target)

    expect(result).toEqual({ ok: true, copiedOnly: false })
    expect(helperActivate).toHaveBeenCalledWith({ bundleId: 'com.apple.TextEdit', pid: 900 })
    expect(state.order).toEqual([
      'clipboard.writeText:ответ',
      'delay:40',
      'delay:300',
      'restoreClipboard'
    ])
  })

  it('snapshots the clipboard before writing the answer', async () => {
    await pasteAnswer('ответ', target)

    expect(snapshotClipboard).toHaveBeenCalledTimes(1)
    expect(snapshotClipboard.mock.invocationCallOrder[0]).toBeLessThan(
      restoreClipboard.mock.invocationCallOrder[0]
    )
  })

  it('sends Cmd+V between the write and the restore', async () => {
    await pasteAnswer('ответ', target)

    expect(helperSendKey).toHaveBeenCalledWith('paste')
    const write = state.order.indexOf('clipboard.writeText:ответ')
    const restore = state.order.indexOf('restoreClipboard')
    expect(write).toBeLessThan(restore)
    expect(state.order.slice(write, restore)).toContain('delay:300')
  })

  it('waits 300 ms for the target to consume the pasteboard before restoring', async () => {
    await pasteAnswer('ответ', target)

    expect(state.order).toContain('delay:300')
    expect(state.order.indexOf('delay:300')).toBeLessThan(state.order.indexOf('restoreClipboard'))
  })

  it('runs the paste through the clipboard queue', async () => {
    await pasteAnswer('ответ', target)

    expect(withClipboard).toHaveBeenCalled()
  })
})

describe('pasteAnswer: bringing the target back to the front', () => {
  it('waits for the target to actually become frontmost', async () => {
    await pasteAnswer('ответ', target)

    expect(waitFor).toHaveBeenCalledTimes(1)
    expect(state.waitForCalls[0]).toEqual({ timeoutMs: 1500, intervalMs: 50 })
  })

  it('accepts the target by bundle id', async () => {
    helperFront.mockResolvedValue({ bundleId: 'com.apple.TextEdit', pid: 1 })

    expect((await pasteAnswer('ответ', target)).ok).toBe(true)
  })

  it('accepts the target by pid when the bundle id is missing', async () => {
    helperFront.mockResolvedValue({ bundleId: '', pid: 900 })

    expect((await pasteAnswer('ответ', target)).ok).toBe(true)
  })

  it('does not accept a different app', async () => {
    helperFront.mockResolvedValue({ bundleId: 'com.apple.Safari', pid: 12 })

    expect((await pasteAnswer('ответ', target)).copiedOnly).toBe(true)
  })

  it('treats a failed front read as "not yet"', async () => {
    helperFront.mockResolvedValue(null)

    expect((await pasteAnswer('ответ', target)).copiedOnly).toBe(true)
  })

  it('never matches on pid 0', async () => {
    helperFront.mockResolvedValue({ bundleId: '', pid: 0 })

    expect((await pasteAnswer('ответ', { ...target, pid: 0 })).copiedOnly).toBe(true)
  })
})

describe('pasteAnswer: falling back to the clipboard', () => {
  it('copies only when there is no target at all', async () => {
    const result = await pasteAnswer('ответ', null)

    expect(result).toEqual({
      ok: false,
      copiedOnly: true,
      message: 'Не удалось вернуться в исходное приложение — ответ скопирован в буфер обмена.'
    })
    expect(helperActivate).not.toHaveBeenCalled()
    expect(state.order).toEqual(['clipboard.writeText:ответ'])
  })

  it('copies only when activation fails', async () => {
    helperActivate.mockResolvedValue(false)

    const result = await pasteAnswer('ответ', target)

    expect(result.copiedOnly).toBe(true)
    expect(helperSendKey).not.toHaveBeenCalled()
    expect(state.order).toEqual(['clipboard.writeText:ответ'])
  })

  it('copies only when the app never comes to the front', async () => {
    state.waitForAnswers = [false]

    const result = await pasteAnswer('ответ', target)

    expect(result.copiedOnly).toBe(true)
    expect(result.message).toBe(
      'Не удалось вернуться в исходное приложение — ответ скопирован в буфер обмена.'
    )
    expect(helperSendKey).not.toHaveBeenCalled()
  })

  it('copies only when Cmd+V could not be sent, and restores the clipboard', async () => {
    helperSendKey.mockResolvedValue(false)

    const result = await pasteAnswer('ответ', target)

    expect(result).toEqual({
      ok: false,
      copiedOnly: true,
      message: 'Вставка недоступна в этом поле — ответ скопирован в буфер обмена.'
    })
    expect(state.order).toEqual([
      'clipboard.writeText:ответ',
      'delay:40',
      'restoreClipboard',
      'clipboard.writeText:ответ'
    ])
  })

  it('puts the answer back on the clipboard after a failed paste', async () => {
    helperSendKey.mockResolvedValue(false)

    await pasteAnswer('ответ', target)

    // The final write is the fallback: the answer, not the old buffer.
    expect(state.order.at(-1)).toBe('clipboard.writeText:ответ')
  })
})
