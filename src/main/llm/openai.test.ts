import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ChatMessage, StreamOptions } from './provider'
import { OpenAIProvider } from './openai'
import { OpenRouterProvider } from './openrouter'

/** A `text/event-stream` response body carrying the given chunks. */
function sse(...chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    }
  })
}

function dataEvent(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`
}

function delta(text: string): string {
  return dataEvent({ choices: [{ delta: { content: text } }] })
}

function options(overrides: Partial<StreamOptions> = {}): StreamOptions {
  return {
    model: 'gpt-4o-mini',
    temperature: 0.7,
    maxTokens: 2048,
    baseUrl: 'https://api.openai.com/v1',
    signal: new AbortController().signal,
    ...overrides
  }
}

const messages: ChatMessage[] = [
  { role: 'system', parts: [{ type: 'text', text: 'Ты помощник.' }] },
  { role: 'user', parts: [{ type: 'text', text: 'Что тут?' }] }
]

function provider(): OpenAIProvider {
  return new OpenAIProvider({
    id: 'openai',
    label: '[OI]',
    baseUrl: 'https://api.openai.com/v1'
  })
}

async function drain(generator: AsyncGenerator<{ delta: string }>): Promise<string[]> {
  const out: string[] = []
  for await (const chunk of generator) out.push(chunk.delta)
  return out
}

/** The fetch mock, typed so the captured arguments can be read back. */
const fetchMock = vi.fn()

function respond(body: ReadableStream<Uint8Array> | null, status = 200): void {
  fetchMock.mockResolvedValue(new Response(body, { status }))
}

afterEach(() => {
  vi.unstubAllGlobals()
  fetchMock.mockReset()
})

describe('[OI]Provider: the request', () => {
  it('posts to /chat/completions under the base URL', async () => {
    vi.stubGlobal('fetch', fetchMock)
    respond(sse(dataEvent({ choices: [{ delta: { content: 'ok' } }] })))

    await drain(provider().stream(messages, '', options()))

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api.openai.com/v1/chat/completions')
    expect(init.method).toBe('POST')
  })

  it('lets the per-request base URL win over the built-in one, without doubling the slash', async () => {
    vi.stubGlobal('fetch', fetchMock)
    respond(sse(dataEvent({ choices: [] })))

    await drain(provider().stream(messages, '', options({ baseUrl: 'https://proxy.example/v1/' })))

    expect((fetchMock.mock.calls[0] as [string])[0]).toBe('https://proxy.example/v1/chat/completions')
  })

  it('falls back to the built-in base URL when the request has none', async () => {
    vi.stubGlobal('fetch', fetchMock)
    respond(sse(dataEvent({ choices: [] })))

    await drain(provider().stream(messages, '', options({ baseUrl: '' })))

    expect((fetchMock.mock.calls[0] as [string])[0]).toBe('https://api.openai.com/v1/chat/completions')
  })

  it('sends the bearer key and the JSON content type', async () => {
    vi.stubGlobal('fetch', fetchMock)
    respond(sse(dataEvent({ choices: [] })))

    await drain(provider().stream(messages, '', options()))

    const init = (fetchMock.mock.calls[0] as [string, RequestInit])[1]
    expect(init.headers).toEqual({
      Authorization: 'Bearer ',
      'Content-Type': 'application/json'
    })
  })

  it('passes the abort signal through', async () => {
    vi.stubGlobal('fetch', fetchMock)
    respond(sse(dataEvent({ choices: [] })))
    const controller = new AbortController()

    await drain(provider().stream(messages, '', options({ signal: controller.signal })))

    const init = (fetchMock.mock.calls[0] as [string, RequestInit])[1]
    expect(init.signal).toBe(controller.signal)
  })

  it('sends the golden body for a text-only conversation', async () => {
    vi.stubGlobal('fetch', fetchMock)
    respond(sse(dataEvent({ choices: [] })))

    await drain(provider().stream(messages, '', options()))

    const init = (fetchMock.mock.calls[0] as [string, RequestInit])[1]
    expect(JSON.parse(init.body as string)).toEqual({
      model: 'gpt-4o-mini',
      temperature: 0.7,
      max_tokens: 2048,
      stream: true,
      messages: [
        { role: 'system', content: 'Ты помощник.' },
        { role: 'user', content: 'Что тут?' }
      ]
    })
  })

  it('joins several text parts with a blank line and trims', async () => {
    vi.stubGlobal('fetch', fetchMock)
    respond(sse(dataEvent({ choices: [] })))

    await drain(
      provider().stream(
        [{ role: 'user', parts: [{ type: 'text', text: '  первая  ' }, { type: 'text', text: 'вторая' }] }],
        '',
        options()
      )
    )

    const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string)
    // Only the ends are trimmed; the padding before the join stays (KNOWN: no per-part trim).
    expect(body.messages[0].content).toBe('первая  \n\nвторая')
  })

  it('sends a part array with image_url when a screenshot is attached', async () => {
    vi.stubGlobal('fetch', fetchMock)
    respond(sse(dataEvent({ choices: [] })))

    await drain(
      provider().stream(
        [
          {
            role: 'user',
            parts: [
              { type: 'text', text: 'Что тут?' },
              { type: 'image', mimeType: 'image/jpeg', base64: 'QUJD' }
            ]
          }
        ],
        '',
        options()
      )
    )

    const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string)
    expect(body.messages[0].content).toEqual([
      { type: 'text', text: 'Что тут?' },
      { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,QUJD' } }
    ])
  })

  it('keeps every role, including system, in the same list', async () => {
    vi.stubGlobal('fetch', fetchMock)
    respond(sse(dataEvent({ choices: [] })))

    await drain(
      provider().stream(
        [
          { role: 'system', parts: [{ type: 'text', text: 'S' }] },
          { role: 'user', parts: [{ type: 'text', text: 'U' }] },
          { role: 'assistant', parts: [{ type: 'text', text: 'A' }] },
          { role: 'user', parts: [{ type: 'text', text: 'U2' }] }
        ],
        '',
        options()
      )
    )

    const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string)
    expect(body.messages.map((message: { role: string }) => message.role)).toEqual([
      'system',
      'user',
      'assistant',
      'user'
    ])
  })
})

describe('[OI]Provider: reading the stream', () => {
  it('yields deltas in order', async () => {
    vi.stubGlobal('fetch', fetchMock)
    respond(sse(delta('При'), delta('вет'), delta('!')))

    expect(await drain(provider().stream(messages, '', options()))).toEqual([
      'При',
      'вет',
      '!'
    ])
  })

  it('stops at [DONE] and ignores anything after it', async () => {
    vi.stubGlobal('fetch', fetchMock)
    respond(sse(delta('a'), 'data: [DONE]\n\n', delta('never')))

    expect(await drain(provider().stream(messages, '', options()))).toEqual(['a'])
  })

  it('skips a chunk that is not valid JSON', async () => {
    vi.stubGlobal('fetch', fetchMock)
    respond(sse('data: not json\n\n', delta('ok')))

    expect(await drain(provider().stream(messages, '', options()))).toEqual(['ok'])
  })

  it('skips an event with no content, an empty delta and a null delta', async () => {
    vi.stubGlobal('fetch', fetchMock)
    respond(
      sse(
        dataEvent({ choices: [] }),
        dataEvent({ choices: [{ delta: {} }] }),
        dataEvent({ choices: [{ delta: { content: null } }] }),
        dataEvent({ choices: [{ delta: { content: '' } }] }),
        delta('real')
      )
    )

    expect(await drain(provider().stream(messages, '', options()))).toEqual(['real'])
  })

  it('keeps a delta that arrives split across chunks', async () => {
    vi.stubGlobal('fetch', fetchMock)
    respond(sse('data: {"choices":[{"delta":{"content":"сло', 'во"}}]}\n\n'))

    expect(await drain(provider().stream(messages, '', options()))).toEqual(['слово'])
  })

  it('throws the error a streamed payload carries', async () => {
    vi.stubGlobal('fetch', fetchMock)
    respond(sse(dataEvent({ error: { message: 'rate limited' } })))

    await expect(drain(provider().stream(messages, '', options()))).rejects.toThrow(
      'Ошибка модели: rate limited'
    )
  })

  it('returns nothing for an empty stream', async () => {
    vi.stubGlobal('fetch', fetchMock)
    respond(sse())

    expect(await drain(provider().stream(messages, '', options()))).toEqual([])
  })

  it('throws when the response has no body', async () => {
    vi.stubGlobal('fetch', fetchMock)
    respond(null)

    await expect(drain(provider().stream(messages, '', options()))).rejects.toThrow(
      'Пустой ответ от сервиса модели.'
    )
  })
})

describe('[OI]Provider: failures', () => {
  it('maps a non-2xx response through toProviderError', async () => {
    vi.stubGlobal('fetch', fetchMock)
    respond(null, 401)

    await expect(drain(provider().stream(messages, '', options()))).rejects.toThrow(
      'Ключ [OI] не принят. Проверь ключ в настройках.'
    )
  })

  it('maps a network failure through toTransportError', async () => {
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockRejectedValue(new Error('fetch failed'))

    await expect(drain(provider().stream(messages, '', options()))).rejects.toThrow(
      'Нет соединения с интернетом или сервис недоступен.'
    )
  })

  it('reports a cancelled request as cancelled', async () => {
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()
    controller.abort()
    fetchMock.mockRejectedValue(new Error('The operation was aborted'))

    await expect(
      drain(provider().stream(messages, '', options({ signal: controller.signal })))
    ).rejects.toThrow('Запрос отменён.')
  })
})

describe('OpenRouterProvider: the same dialect plus attribution', () => {
  it('identifies itself as openrouter', () => {
    expect(new OpenRouterProvider().id).toBe('openrouter')
  })

  it('posts to the OpenRouter base URL', async () => {
    vi.stubGlobal('fetch', fetchMock)
    respond(sse(dataEvent({ choices: [] })))

    await drain(new OpenRouterProvider().stream(messages, 'sk-or', options({ baseUrl: '' })))

    expect((fetchMock.mock.calls[0] as [string])[0]).toBe(
      'https://openrouter.ai/api/v1/chat/completions'
    )
  })

  it('adds exactly two attribution headers on top of the [OI] ones', async () => {
    vi.stubGlobal('fetch', fetchMock)
    respond(sse(dataEvent({ choices: [] })))

    await drain(new OpenRouterProvider().stream(messages, 'sk-or', options()))

    expect((fetchMock.mock.calls[0] as [string, RequestInit])[1].headers).toEqual({
      Authorization: 'Bearer sk-or',
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://github.com/BobrAll/deskhand',
      'X-Title': 'Deskhand'
    })
  })

  it('sends the same body shape as [OI]', async () => {
    vi.stubGlobal('fetch', fetchMock)
    respond(sse(dataEvent({ choices: [] })))

    await drain(new OpenRouterProvider().stream(messages, 'sk-or', options()))

    const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string)
    expect(Object.keys(body).sort()).toEqual([
      'max_tokens',
      'messages',
      'model',
      'stream',
      'temperature'
    ])
  })

  it('names OpenRouter in its errors', async () => {
    vi.stubGlobal('fetch', fetchMock)
    respond(null, 402)

    await expect(
      drain(new OpenRouterProvider().stream(messages, 'sk-or', options()))
    ).rejects.toThrow('Недостаточно средств на счёте OpenRouter.')
  })

  it('reads the stream exactly as [OI] does', async () => {
    vi.stubGlobal('fetch', fetchMock)
    respond(sse(delta('a'), 'data: [DONE]\n\n', delta('b')))

    expect(await drain(new OpenRouterProvider().stream(messages, 'sk-or', options()))).toEqual(['a'])
  })
})

it.each([
  ['stop', 'data: [DONE]\n\n', 'complete'],
  ['length', 'data: [DONE]\n\n', 'limit'],
  ['stop', '', 'incomplete'],
  ['stop', 'data: [DONE]', 'incomplete']
])('checks finish_reason %s and the terminal SSE frame', async (reason, trailer, expected) => {
  vi.stubGlobal('fetch', fetchMock)
  respond(sse(delta('@key enter\n'), dataEvent({ choices: [{ finish_reason: reason }] }), trailer))
  const stream = provider().stream(messages, 'key', options())
  expect(await stream.next()).toEqual({ value: { delta: '@key enter\n' }, done: false })
  expect(await stream.next()).toEqual({ value: expected, done: true })
})
