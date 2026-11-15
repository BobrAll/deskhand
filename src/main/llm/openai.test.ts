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

/** A body that delivers one chunk and then dies the way a dropped socket does. */
function brokenStream(chunk: string, error: Error): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  let sent = false
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent) {
        controller.error(error)
        return
      }
      sent = true
      controller.enqueue(encoder.encode(chunk))
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

  it('preserves the Base URL query when building the chat endpoint', async () => {
    vi.stubGlobal('fetch', fetchMock)
    respond(sse(dataEvent({ choices: [] })))

    await drain(provider().stream(messages, '', options({ baseUrl: 'https://proxy.example/v1/?tenant=deskhand#docs' })))

    expect(fetchMock.mock.calls[0][0]).toBe('https://proxy.example/v1/chat/completions?tenant=deskhand')
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
      stream_options: { include_usage: true },
      messages: [
        { role: 'system', content: 'Ты помощник.' },
        { role: 'user', content: 'Что тут?' }
      ]
    })
  })

  it.each(['o3', 'o3-mini', 'gpt-5', 'gpt-5.1', 'openai/gpt-5-mini'])(
    'sends the token limit of a reasoning model %s as max_completion_tokens and no temperature',
    async (model) => {
      vi.stubGlobal('fetch', fetchMock)
      respond(sse(dataEvent({ choices: [] })))

      await drain(provider().stream(messages, '', options({ model })))

      const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string)
      expect(body).toMatchObject({ model, max_completion_tokens: 2048, stream: true })
      expect(body).not.toHaveProperty('max_tokens')
      expect(body).not.toHaveProperty('temperature')
    }
  )

  it.each(['gpt-4o-mini', 'gpt-4.1', 'claude-3-5-sonnet', 'local-model'])(
    'keeps max_tokens and temperature for %s',
    async (model) => {
      vi.stubGlobal('fetch', fetchMock)
      respond(sse(dataEvent({ choices: [] })))

      await drain(provider().stream(messages, '', options({ model })))

      const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string)
      expect(body).toMatchObject({ model, max_tokens: 2048, temperature: 0.7 })
      expect(body).not.toHaveProperty('max_completion_tokens')
    }
  )

  it('asks the stream to include usage', async () => {
    vi.stubGlobal('fetch', fetchMock)
    respond(sse(dataEvent({ choices: [] })))

    await drain(provider().stream(messages, '', options()))

    const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string)
    expect(body.stream_options).toEqual({ include_usage: true })
  })

  it("lets the caller's own stream_options win, including the opt-out", async () => {
    vi.stubGlobal('fetch', fetchMock)
    fetchMock
      .mockResolvedValueOnce(new Response(sse(dataEvent({ choices: [] }))))
      .mockResolvedValueOnce(new Response(sse(dataEvent({ choices: [] }))))

    await drain(
      provider().stream(messages, '', options({ extraBody: { stream_options: { include_usage: false } } }))
    )
    await drain(
      provider().stream(messages, '', options({ extraBody: { stream_options: undefined } }))
    )

    const body = (index: number): Record<string, unknown> =>
      JSON.parse((fetchMock.mock.calls[index] as [string, RequestInit])[1].body as string)
    expect(body(0).stream_options).toEqual({ include_usage: false })
    // `undefined` drops the field from the JSON body entirely.
    expect(body(1)).not.toHaveProperty('stream_options')
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

  it('does not let a skipped event downgrade a turn that finished', async () => {
    vi.stubGlobal('fetch', fetchMock)
    respond(
      sse(
        'data:\n\n',
        'data: not json\n\n',
        delta('ок'),
        dataEvent({ choices: [{ finish_reason: 'stop' }] }),
        'data: [DONE]\n\n'
      )
    )

    const stream = provider().stream(messages, '', options())
    expect(await stream.next()).toEqual({ value: { delta: 'ок' }, done: false })
    expect(await stream.next()).toEqual({ value: 'complete', done: true })
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

  it.each([
    [{ type: 'overloaded_error' }, 'overloaded_error'],
    [{ code: 'insufficient_quota' }, 'insufficient_quota'],
    [{}, 'причина не указана']
  ])('treats an error event %j as fatal', async (error, detail) => {
    vi.stubGlobal('fetch', fetchMock)
    respond(sse(delta('partial'), dataEvent({ error })))

    await expect(drain(provider().stream(messages, '', options()))).rejects.toThrow(
      `Ошибка модели: ${detail}`
    )
  })

  it('ignores a chunk that is not an object', async () => {
    vi.stubGlobal('fetch', fetchMock)
    respond(sse('data: null\n\n', 'data: 7\n\n', delta('ok'), 'data: [DONE]\n\n'))

    expect(await drain(provider().stream(messages, '', options()))).toEqual(['ok'])
  })

  it('accepts the usage-only chunk that stream_options adds', async () => {
    vi.stubGlobal('fetch', fetchMock)
    respond(
      sse(
        delta('a'),
        dataEvent({ choices: [{ finish_reason: 'stop' }] }),
        dataEvent({ choices: [], usage: { prompt_tokens: 5, completion_tokens: 2 } }),
        'data: [DONE]\n\n'
      )
    )

    const stream = provider().stream(messages, '', options())
    expect(await stream.next()).toEqual({ value: { delta: 'a' }, done: false })
    expect(await stream.next()).toEqual({ value: 'complete', done: true })
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

  it('maps a connection that dies mid-stream instead of leaking the raw failure', async () => {
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockResolvedValue(new Response(brokenStream(delta('При'), new TypeError('terminated'))))

    await expect(drain(provider().stream(messages, '', options()))).rejects.toThrow(
      'Нет соединения с интернетом или сервис недоступен.'
    )
  })

  it('reports a stream read cut by the abort signal as cancelled', async () => {
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()
    fetchMock.mockResolvedValue(new Response(brokenStream(delta('a'), new TypeError('terminated'))))

    const stream = provider().stream(messages, '', options({ signal: controller.signal }))
    expect(await stream.next()).toEqual({ value: { delta: 'a' }, done: false })
    controller.abort()
    await expect(stream.next()).rejects.toThrow('Запрос отменён.')
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
      'stream_options',
      'temperature'
    ])
  })

  it('names OpenRouter in its errors', async () => {
    vi.stubGlobal('fetch', fetchMock)
    respond(null, 402)

    await expect(
      drain(new OpenRouterProvider().stream(messages, 'sk-or', options()))
    ).rejects.toThrow('Ключ OpenRouter действителен, но на счёте нет средств.')
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
