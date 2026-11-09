import { describe, expect, it, vi } from 'vitest'

import type { Annotation } from '@shared/types'
import type { ChatMessage, LlmProvider, StreamChunk, StreamEnd, StreamOptions } from './llm/provider'
import { consumeTurnStream } from './turnStream'

/**
 * The seam under test is the whole "stream → parse → paint/emit" chain of one
 * round. It is driven here by a fake provider, so what is asserted is the
 * contract the overlay depends on: shapes arrive as they are parsed, prose
 * arrives as it is parsed, a marker split by a chunk boundary is not lost, and a
 * cancelled round stops at the first delta that notices.
 */

const MESSAGES: ChatMessage[] = [{ role: 'user', parts: [{ type: 'text', text: 'привет' }] }]

const STREAM_OPTIONS: StreamOptions = {
  model: 'test-model',
  temperature: 0.2,
  maxTokens: 100,
  baseUrl: 'https://example.invalid/v1',
  signal: new AbortController().signal
}

/** A provider that yields exactly the deltas it was given, and records the call. */
function fakeProvider(deltas: string[], failWith?: Error, end: StreamEnd = 'complete'): LlmProvider & {
  calls: Array<{ messages: ChatMessage[]; apiKey: string; options: StreamOptions }>
} {
  const calls: Array<{ messages: ChatMessage[]; apiKey: string; options: StreamOptions }> = []
  return {
    id: 'openai',
    calls,
    async *stream(messages, apiKey, options): AsyncGenerator<StreamChunk, StreamEnd> {
      calls.push({ messages, apiKey, options })
      for (const delta of deltas) {
        if (failWith) throw failWith
        yield { delta }
      }
      return end
    }
  }
}

/** Collects what the round reported, in the order it reported it. */
function recorder(): {
  shapes: Annotation[][]
  text: string[]
  onShapes(shapes: Annotation[]): void
  onText(delta: string): void
} {
  const shapes: Annotation[][] = []
  const text: string[] = []
  return {
    shapes,
    text,
    onShapes: (next) => shapes.push(next),
    onText: (delta) => text.push(delta)
  }
}

describe('consumeTurnStream: the request it makes', () => {
  it('calls the provider with the messages, key and options it was given', async () => {
    const provider = fakeProvider(['ок\n'])
    await consumeTurnStream({
      provider,
      messages: MESSAGES,
      apiKey: '',
      streamOptions: STREAM_OPTIONS,
      isAlive: () => true,
      onShapes: () => undefined,
      onText: () => undefined
    })

    expect(provider.calls).toHaveLength(1)
    expect(provider.calls[0].messages).toBe(MESSAGES)
    expect(provider.calls[0].apiKey).toBe('')
    expect(provider.calls[0].options).toBe(STREAM_OPTIONS)
  })
})

describe('consumeTurnStream: prose', () => {
  it('captures the web lookup marker across chunks without printing it', async () => {
    const out = recorder()
    const result = await consumeTurnStream({
      provider: fakeProvider(['@we', 'b']),
      messages: MESSAGES,
      apiKey: '',
      streamOptions: STREAM_OPTIONS,
      isAlive: () => true,
      onShapes: out.onShapes,
      onText: out.onText
    })

    expect(result).toEqual({ text: '', webLookup: true })
    expect(out.text).toEqual([])
  })

  it('reports every piece of prose as it arrives and returns it joined', async () => {
    const out = recorder()
    const result = await consumeTurnStream({
      provider: fakeProvider(['Первое ', 'предложение. ', 'Второе.']),
      messages: MESSAGES,
      apiKey: '',
      streamOptions: STREAM_OPTIONS,
      isAlive: () => true,
      onShapes: out.onShapes,
      onText: out.onText
    })

    expect(out.text).toEqual(['Первое ', 'предложение. ', 'Второе.'])
    expect(result.text).toBe('Первое предложение. Второе.')
  })

  it('never reports an empty delta', async () => {
    const out = recorder()
    await consumeTurnStream({
      provider: fakeProvider(['', 'ответ', '']),
      messages: MESSAGES,
      apiKey: '',
      streamOptions: STREAM_OPTIONS,
      isAlive: () => true,
      onShapes: out.onShapes,
      onText: out.onText
    })

    expect(out.text).toEqual(['ответ'])
  })

  it('keeps markers out of the prose and hands them over as shapes instead', async () => {
    const out = recorder()
    const result = await consumeTurnStream({
      provider: fakeProvider(['Смотри:\n@point circle 0.4 0.6\n', 'Вот тут.\n']),
      messages: MESSAGES,
      apiKey: '',
      streamOptions: STREAM_OPTIONS,
      isAlive: () => true,
      onShapes: out.onShapes,
      onText: out.onText
    })

    expect(result.text).toBe('Смотри:\nВот тут.\n')
    expect(out.shapes.flat().map((shape) => shape.kind)).toEqual(['circle'])
    expect(out.shapes.flat()[0].from).toEqual({ x: 0.4, y: 0.6 })
  })
})

describe('consumeTurnStream: shapes', () => {
  it('reports shapes only when there is something to draw', async () => {
    const out = recorder()
    await consumeTurnStream({
      provider: fakeProvider(['Просто текст, ', 'без разметки.']),
      messages: MESSAGES,
      apiKey: '',
      streamOptions: STREAM_OPTIONS,
      isAlive: () => true,
      onShapes: out.onShapes,
      onText: out.onText
    })

    expect(out.shapes).toEqual([])
  })

  it('drops a shape that would cover the whole screen instead of painting it', async () => {
    const out = recorder()
    await consumeTurnStream({
      provider: fakeProvider(['@point box 0.01 0.01 0.99 0.99\n@point arrow 0.2 0.2 0.6 0.7\n']),
      messages: MESSAGES,
      apiKey: '',
      streamOptions: STREAM_OPTIONS,
      isAlive: () => true,
      onShapes: out.onShapes,
      onText: out.onText
    })

    const painted = out.shapes.flat()
    expect(painted).toHaveLength(1)
    expect(painted[0].from).toEqual({ x: 0.2, y: 0.2 })
  })

  it('does not paint a marker cut by a chunk boundary until it is complete', async () => {
    const out = recorder()
    await consumeTurnStream({
      provider: fakeProvider(['@point ci', 'rcle 0.5 0.5\n']),
      messages: MESSAGES,
      apiKey: '',
      streamOptions: STREAM_OPTIONS,
      isAlive: () => true,
      onShapes: out.onShapes,
      onText: out.onText
    })

    expect(out.shapes.flat().map((shape) => shape.kind)).toEqual(['circle'])
    // Nothing is painted for the first, incomplete delta: it could still have
    // turned into any other marker.
    expect(out.shapes).toHaveLength(1)
  })

  it('paints the tail the parser was holding back when the stream ends', async () => {
    const out = recorder()
    const result = await consumeTurnStream({
      // No trailing newline: the marker only becomes decidable at `finish()`.
      provider: fakeProvider(['Смотри:\n@point box 0.1 0.1 0.5 0.5']),
      messages: MESSAGES,
      apiKey: '',
      streamOptions: STREAM_OPTIONS,
      isAlive: () => true,
      onShapes: out.onShapes,
      onText: out.onText
    })

    expect(result.text).toBe('Смотри:\n')
    expect(out.shapes.flat().map((shape) => shape.kind)).toEqual(['box'])
  })
})

describe('consumeTurnStream: markers are drawing only', () => {
  it('keeps an action-shaped line out of the plan and in the prose', async () => {
    // Acting is its own turn with real tool calling. A line the old protocol
    // would have read as a click is now just text, and the parser says so.
    const result = await consumeTurnStream({
      provider: fakeProvider(['@click 0.3 0.4\n', 'Готово.\n']),
      messages: MESSAGES,
      apiKey: '',
      streamOptions: STREAM_OPTIONS,
      isAlive: () => true,
      onShapes: () => undefined,
      onText: () => undefined
    })

    expect(result.text).toBe('@click 0.3 0.4\nГотово.\n')
  })
})

describe('consumeTurnStream: a round that is no longer wanted', () => {
  it('stops at the first delta after the card is gone, keeping what it had', async () => {
    const out = recorder()
    let alive = true
    const result = await consumeTurnStream({
      provider: fakeProvider(['Первое. ', 'Второе. ', 'Третье. ']),
      messages: MESSAGES,
      apiKey: '',
      streamOptions: STREAM_OPTIONS,
      isAlive: () => alive,
      onShapes: out.onShapes,
      onText: (delta) => {
        out.onText(delta)
        alive = false
      }
    })

    expect(out.text).toEqual(['Первое. '])
    expect(result.text).toBe('Первое. ')
  })

  it('checks `isAlive` before the first delta, so a closed card consumes nothing', async () => {
    const out = recorder()
    const result = await consumeTurnStream({
      provider: fakeProvider(['ответ']),
      messages: MESSAGES,
      apiKey: '',
      streamOptions: STREAM_OPTIONS,
      isAlive: () => false,
      onShapes: out.onShapes,
      onText: out.onText
    })

    expect(out.text).toEqual([])
    expect(out.shapes).toEqual([])
    expect(result).toEqual({ text: '' })
  })

  it('drops the tail when the round was cancelled during the last delta', async () => {
    const out = recorder()
    let alive = true
    const result = await consumeTurnStream({
      provider: fakeProvider(['Смотри:\n@point circle 0.5 0.5']),
      messages: MESSAGES,
      apiKey: '',
      streamOptions: STREAM_OPTIONS,
      isAlive: () => alive,
      onShapes: out.onShapes,
      onText: (delta) => {
        out.onText(delta)
        alive = false
      }
    })

    // The held-back marker must not be painted for a card nobody is looking at.
    expect(out.shapes).toEqual([])
    expect(result.text).toBe('Смотри:\n')
  })

  it('does not paint a shape that arrives after the card is gone', async () => {
    // The per-delta `isAlive` check is what stops the *next* delta, not just the
    // prose of the current one: `paint` has no aliveness of its own, so a marker
    // parsed after the card closed would otherwise be drawn on a screen nobody
    // is looking at.
    const out = recorder()
    let alive = true
    await consumeTurnStream({
      provider: fakeProvider(['Смотри. ', '@point circle 0.5 0.5\n']),
      messages: MESSAGES,
      apiKey: '',
      streamOptions: STREAM_OPTIONS,
      isAlive: () => alive,
      onShapes: out.onShapes,
      onText: (delta) => {
        out.onText(delta)
        alive = false
      }
    })

    expect(out.shapes).toEqual([])
  })

  it('hands the tail to onText when it never became a marker', async () => {
    // `@po` looks like the start of a marker, so the parser holds it back until
    // the stream ends. Only `finish()` can decide it is prose, which means the
    // last thing the user reads arrives through the tail path.
    const out = recorder()
    const result = await consumeTurnStream({
      provider: fakeProvider(['Готово\n@po']),
      messages: MESSAGES,
      apiKey: '',
      streamOptions: STREAM_OPTIONS,
      isAlive: () => true,
      onShapes: out.onShapes,
      onText: out.onText
    })

    expect(out.text.join('')).toBe('Готово\n@po\n')
    expect(result.text).toBe('Готово\n@po\n')
  })

  it('lets a provider failure propagate, because the caller owns the retry', async () => {
    const boom = new Error('provider exploded')
    const onShapes = vi.fn()
    await expect(
      consumeTurnStream({
        provider: fakeProvider(['нач', 'ало'], boom),
        messages: MESSAGES,
        apiKey: '',
        streamOptions: STREAM_OPTIONS,
        isAlive: () => true,
        onShapes,
        onText: () => undefined
      })
    ).rejects.toThrow('provider exploded')
  })
})

describe('consumeTurnStream: execution integrity', () => {
  it.each(['incomplete', 'limit'] as const)('rejects a truncated web lookup on %s', async (end) => {
    // A search marker that arrived in a stream nobody finished is a lookup the
    // answer no longer justifies: retrying is honest, answering is not.
    await expect(consumeTurnStream({
      provider: fakeProvider(['@web\nИщу'], undefined, end),
      messages: MESSAGES, apiKey: '', streamOptions: STREAM_OPTIONS, isAlive: () => true,
      onShapes: () => undefined, onText: () => undefined
    })).rejects.toThrow('Ответ модели оборвался')
  })

  it('keeps a truncated plain answer: it is still readable prose', async () => {
    const result = await consumeTurnStream({
      provider: fakeProvider(['Первое предложение. Второе предло'], undefined, 'incomplete'),
      messages: MESSAGES, apiKey: '', streamOptions: STREAM_OPTIONS, isAlive: () => true,
      onShapes: () => undefined, onText: () => undefined
    })

    expect(result.text).toBe('Первое предложение. Второе предло')
  })
})
