import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  order: [] as string[],
  text: '',
  html: '',
  rtf: '',
  bookmark: { title: '', url: '' },
  hasPng: false
}))

vi.mock('electron', () => ({
  clipboard: {
    clear: () => state.order.push('clear'),
    readText: () => state.text,
    readHTML: () => state.html,
    readRTF: () => state.rtf,
    readBookmark: () => state.bookmark,
    has: (format: string) => format === 'image/png' && state.hasPng,
    readImage: () => ({ toPNG: () => Buffer.from('png-bytes') }),
    writeText: (text: string) => state.order.push(`writeText:${text}`),
    writeImage: (image: unknown) => state.order.push(`writeImage:${JSON.stringify(image)}`),
    writeBookmark: (title: string, url: string) => state.order.push(`writeBookmark:${title}|${url}`),
    write: (data: { text?: string; html?: string; rtf?: string }) => state.order.push(`write:${JSON.stringify(data)}`)
  },
  nativeImage: {
    createFromBuffer: (buffer: Buffer) => ({ buffer: buffer.toString() })
  }
}))

import { copyText, restoreClipboard, snapshotClipboard, withClipboard, type ClipboardSnapshot } from './clipboard'

beforeEach(() => {
  state.order = []
  state.text = ''
  state.html = ''
  state.rtf = ''
  state.bookmark = { title: '', url: '' }
  state.hasPng = false
})

describe('withClipboard: one queue for the whole app', () => {
  it('runs a task and resolves with its result', async () => {
    expect(await withClipboard(async () => 42)).toBe(42)
  })

  it('does not start the second task until the first one settles', async () => {
    const order: string[] = []
    let release = (): void => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })

    const first = withClipboard(async () => {
      order.push('first:start')
      await gate
      order.push('first:end')
    })
    const second = withClipboard(async () => {
      order.push('second')
    })

    await Promise.resolve()
    expect(order).toEqual(['first:start'])
    release()
    await Promise.all([first, second])
    expect(order).toEqual(['first:start', 'first:end', 'second'])
  })

  it('keeps the queue usable after a task rejects', async () => {
    const failing = withClipboard(async () => {
      throw new Error('boom')
    })

    await expect(failing).rejects.toThrow('boom')
    expect(await withClipboard(async () => 'still works')).toBe('still works')
  })

  it('keeps running the queue in the order the tasks were queued', async () => {
    const order: string[] = []
    const tasks = [1, 2, 3].map((index) =>
      withClipboard(async () => {
        await Promise.resolve()
        order.push(`task${index}`)
      })
    )

    await Promise.all(tasks)

    expect(order).toEqual(['task1', 'task2', 'task3'])
  })

  it('passes the rejection to the caller without poisoning the queue', async () => {
    const results = await Promise.allSettled([
      withClipboard(async () => {
        throw new Error('first fails')
      }),
      withClipboard(async () => 'second ok')
    ])

    expect(results[0].status).toBe('rejected')
    expect(results[1]).toEqual({ status: 'fulfilled', value: 'second ok' })
  })
})

describe('snapshotClipboard', () => {
  it('reads every format the app may have to put back', () => {
    state.text = 'текст'
    state.html = '<b>текст</b>'
    state.rtf = '{\\rtf1}'
    state.bookmark = { title: 'Сайт', url: 'https://a.example' }
    state.hasPng = true

    expect(snapshotClipboard()).toEqual({
      text: 'текст',
      html: '<b>текст</b>',
      rtf: '{\\rtf1}',
      bookmark: { title: 'Сайт', url: 'https://a.example' },
      png: Buffer.from('png-bytes')
    })
  })

  it('keeps a bookmark only when it has a URL', () => {
    state.bookmark = { title: 'Без адреса', url: '' }

    expect(snapshotClipboard().bookmark).toBeNull()
  })

  it('reads an image only when the pasteboard holds a PNG', () => {
    expect(snapshotClipboard().png).toBeNull()
    state.hasPng = true
    expect(snapshotClipboard().png).not.toBeNull()
  })
})

describe('restoreClipboard: what gets written back', () => {
  const empty: ClipboardSnapshot = {
    text: '',
    html: '',
    rtf: '',
    bookmark: null,
    png: null
  }

  it('always clears first', () => {
    restoreClipboard(empty)

    expect(state.order).toEqual(['clear'])
  })

  it('restores an image and stops there', () => {
    restoreClipboard({ ...empty, png: Buffer.from('png'), text: 'и текст' })

    expect(state.order).toEqual(['clear', 'writeImage:{"buffer":"png"}'])
  })

  it('restores a bookmark when there is no image', () => {
    restoreClipboard({ ...empty, bookmark: { title: 'Сайт', url: 'https://a.example' }, text: 'x' })

    expect(state.order).toEqual(['clear', 'writeBookmark:Сайт|https://a.example'])
  })

  it('restores text, HTML and RTF together', () => {
    restoreClipboard({ ...empty, text: 'текст', html: '<b>текст</b>', rtf: '{\\rtf1}' })

    expect(state.order).toEqual(['clear', 'write:{"text":"текст","html":"<b>текст</b>","rtf":"{\\\\rtf1}"}'])
  })

  it('writes nothing when the snapshot was empty', () => {
    restoreClipboard(empty)

    expect(state.order).toEqual(['clear'])
  })

  it('leaves an absent HTML or RTF out of the write', () => {
    restoreClipboard({ ...empty, text: 'только текст' })

    expect(state.order[1]).toBe('write:{"text":"только текст"}')
  })
})

describe('copyText', () => {
  it('writes the text through the queue', async () => {
    await copyText('ответ')

    expect(state.order).toEqual(['writeText:ответ'])
  })

  it('does not touch the rest of the clipboard', async () => {
    await copyText('ответ')

    expect(state.order).not.toContain('clear')
  })
})
