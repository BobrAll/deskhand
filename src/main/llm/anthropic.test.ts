import { afterEach, describe, expect, it, vi } from 'vitest'

import { AnthropicProvider } from './anthropic'
import type { ChatMessage, StreamOptions } from './provider'

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

function event(payload: unknown): string {
  return `event: message\ndata: ${JSON.stringify(payload)}\n\n`
}

function textDelta(text: string): string {
  return event({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })
}

const STOP = event({ type: 'message_stop' })

function options(overrides: Partial<StreamOptions> = {}): StreamOptions {
  return {
    model: 'claude-3-5-sonnet-latest',
    temperature: 0.7,
    maxTokens: 2048,
    baseUrl: 'https://api.anthropic.com/v1',
    signal: new AbortController().signal,
    ...overrides
  }
}

const messages: ChatMessage[] = [
  { role: 'system', parts: [{ type: 'text', text: 'Ты помощник.' }] },
  { role: 'user', parts: [{ type: 'text', text: 'Что тут?' }] }
]

const fetchMock = vi.fn()

function respond(body: ReadableStream<Uint8Array> | null, status = 200): void {
  fetchMock.mockResolvedValue(new Response(body, { status }))
}

async function drain(generator: AsyncGenerator<{ delta: string }>): Promise<string[]> {
  const out: string[] = []
  for await (const chunk of generator) out.push(chunk.delta)
  return out
}

function request(): { url: string; init: RequestInit; body: Record<string, unknown> } {
  const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
  return { url, init, body: JSON.parse(init.body as string) as Record<string, unknown> }
}

afterEach(() => {
  vi.unstubAllGlobals()
  fetchMock.mockReset()
})

describe('AnthropicProvider: the request', () => {
  it('posts to /messages under the base URL', async () => {
    vi.stubGlobal('fetch', fetchMock)
    respond(sse(STOP))

    await drain(new AnthropicProvider().stream(messages, 'sk-ant', options()))

    expect(request().url).toBe('https://api.anthropic.com/v1/messages')
    expect(request().init.method).toBe('POST')
  })

  it('lets the per-request base URL win, without doubling the slash', async () => {
    vi.stubGlobal('fetch', fetchMock)
    respond(sse(STOP))

    await drain(new AnthropicProvider().stream(messages, 'sk-ant', options({ baseUrl: 'https://proxy.example/v1/' })))

    expect(request().url).toBe('https://proxy.example/v1/messages')
  })

  it('uses the constructor base URL when the request has none', async () => {
    vi.stubGlobal('fetch', fetchMock)
    respond(sse(STOP))

    await drain(new AnthropicProvider('https://custom.example/v2').stream(messages, 'sk-ant', options({ baseUrl: '' })))

    expect(request().url).toBe('https://custom.example/v2/messages')
  })

  it('sends exactly the three Anthropic headers', async () => {
    vi.stubGlobal('fetch', fetchMock)
    respond(sse(STOP))

    await drain(new AnthropicProvider().stream(messages, 'sk-ant', options()))

    expect(request().init.headers).toEqual({
      'x-api-key': 'sk-ant',
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json'
    })
    // No bearer token: the key travels in `x-api-key`.
    expect(request().init.headers).not.toHaveProperty('Authorization')
  })

  it('passes the abort signal through', async () => {
    vi.stubGlobal('fetch', fetchMock)
    respond(sse(STOP))
    const controller = new AbortController()

    await drain(new AnthropicProvider().stream(messages, 'sk-ant', options({ signal: controller.signal })))

    expect(request().init.signal).toBe(controller.signal)
  })

  it('identifies itself as anthropic', () => {
    expect(new AnthropicProvider().id).toBe('anthropic')
  })
})

describe('AnthropicProvider: the body', () => {
  it('sends the golden body for a text-only conversation', async () => {
    vi.stubGlobal('fetch', fetchMock)
    respond(sse(STOP))

    await drain(new AnthropicProvider().stream(messages, 'sk-ant', options()))

    expect(request().body).toEqual({
      model: 'claude-3-5-sonnet-latest',
      max_tokens: 2048,
      temperature: 0.7,
      system: 'Ты помощник.',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Что тут?' }] }],
      stream: true,
      thinking: { type: 'disabled' }
    })
  })

  it('moves the system prompt out of `messages` into a top-level field', async () => {
    vi.stubGlobal('fetch', fetchMock)
    respond(sse(STOP))

    await drain(
      new AnthropicProvider().stream(
        [
          { role: 'system', parts: [{ type: 'text', text: 'S1' }] },
          { role: 'system', parts: [{ type: 'text', text: 'S2' }] },
          { role: 'user', parts: [{ type: 'text', text: 'U' }] }
        ],
        'sk-ant',
        options()
      )
    )

    const body = request().body
    expect(body.system).toBe('S1\n\nS2')
    expect(body.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'U' }] }])
  })

  it('omits the system field entirely when there is no system prompt', async () => {
    vi.stubGlobal('fetch', fetchMock)
    respond(sse(STOP))

    await drain(
      new AnthropicProvider().stream([{ role: 'user', parts: [{ type: 'text', text: 'U' }] }], 'sk-ant', options())
    )

    expect(request().body).not.toHaveProperty('system')
  })

  it('omits the system field when the system prompt is only whitespace', async () => {
    vi.stubGlobal('fetch', fetchMock)
    respond(sse(STOP))

    await drain(
      new AnthropicProvider().stream(
        [
          { role: 'system', parts: [{ type: 'text', text: '   ' }] },
          { role: 'user', parts: [{ type: 'text', text: 'U' }] }
        ],
        'sk-ant',
        options()
      )
    )

    expect(request().body).not.toHaveProperty('system')
  })

  it('sends an image as a base64 source object', async () => {
    vi.stubGlobal('fetch', fetchMock)
    respond(sse(STOP))

    await drain(
      new AnthropicProvider().stream(
        [
          {
            role: 'user',
            parts: [
              { type: 'text', text: 'Что тут?' },
              { type: 'image', mimeType: 'image/jpeg', base64: 'QUJD' }
            ]
          }
        ],
        'sk-ant',
        options()
      )
    )

    expect(request().body.messages).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Что тут?' },
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'QUJD' } }
        ]
      }
    ])
  })

  it('keeps the text/image order the caller gave', async () => {
    vi.stubGlobal('fetch', fetchMock)
    respond(sse(STOP))

    await drain(
      new AnthropicProvider().stream(
        [
          {
            role: 'user',
            parts: [
              { type: 'image', mimeType: 'image/png', base64: 'AAA' },
              { type: 'text', text: 'second' }
            ]
          }
        ],
        'sk-ant',
        options()
      )
    )

    const content = (request().body.messages as Array<{ content: Array<{ type: string }> }>)[0].content
    expect(content.map((block) => block.type)).toEqual(['image', 'text'])
  })

  it('keeps a multi-turn conversation in order, without the system turn', async () => {
    vi.stubGlobal('fetch', fetchMock)
    respond(sse(STOP))

    await drain(
      new AnthropicProvider().stream(
        [
          { role: 'system', parts: [{ type: 'text', text: 'S' }] },
          { role: 'user', parts: [{ type: 'text', text: 'U1' }] },
          { role: 'assistant', parts: [{ type: 'text', text: 'A1' }] },
          { role: 'user', parts: [{ type: 'text', text: 'U2' }] }
        ],
        'sk-ant',
        options()
      )
    )

    const turns = request().body.messages as Array<{ role: string }>
    expect(turns.map((turn) => turn.role)).toEqual(['user', 'assistant', 'user'])
  })
})

describe('AnthropicProvider: reading the stream', () => {
  it('yields text_delta chunks in order', async () => {
    vi.stubGlobal('fetch', fetchMock)
    respond(sse(textDelta('При'), textDelta('вет'), STOP))

    expect(await drain(new AnthropicProvider().stream(messages, 'sk-ant', options()))).toEqual(['При', 'вет'])
  })

  it('stops at message_stop and ignores anything after it', async () => {
    vi.stubGlobal('fetch', fetchMock)
    respond(sse(textDelta('a'), STOP, textDelta('never')))

    expect(await drain(new AnthropicProvider().stream(messages, 'sk-ant', options()))).toEqual(['a'])
  })

  it('ignores every other event type', async () => {
    vi.stubGlobal('fetch', fetchMock)
    respond(
      sse(
        event({ type: 'message_start', message: { id: 'msg_1' } }),
        event({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
        event({ type: 'ping' }),
        event({ type: 'content_block_stop', index: 0 }),
        event({ type: 'message_delta', delta: { stop_reason: 'end_turn' } }),
        textDelta('real'),
        STOP
      )
    )

    expect(await drain(new AnthropicProvider().stream(messages, 'sk-ant', options()))).toEqual(['real'])
  })

  it('ignores a delta that is not a text_delta', async () => {
    vi.stubGlobal('fetch', fetchMock)
    respond(
      sse(
        event({ type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{}' } }),
        textDelta('real'),
        STOP
      )
    )

    expect(await drain(new AnthropicProvider().stream(messages, 'sk-ant', options()))).toEqual(['real'])
  })

  it('ignores an empty text_delta', async () => {
    vi.stubGlobal('fetch', fetchMock)
    respond(sse(textDelta(''), textDelta('real'), STOP))

    expect(await drain(new AnthropicProvider().stream(messages, 'sk-ant', options()))).toEqual(['real'])
  })

  it('skips a chunk that is not valid JSON', async () => {
    vi.stubGlobal('fetch', fetchMock)
    respond(sse('data: not json\n\n', textDelta('ok'), STOP))

    expect(await drain(new AnthropicProvider().stream(messages, 'sk-ant', options()))).toEqual(['ok'])
  })

  it('does not let a skipped event downgrade a turn that finished', async () => {
    vi.stubGlobal('fetch', fetchMock)
    respond(
      sse(
        'data:\n\n',
        'data: not json\n\n',
        textDelta('ок'),
        event({ type: 'message_delta', delta: { stop_reason: 'end_turn' } }),
        STOP
      )
    )

    const stream = new AnthropicProvider().stream(messages, 'sk-ant', options())
    expect(await stream.next()).toEqual({ value: { delta: 'ок' }, done: false })
    expect(await stream.next()).toEqual({ value: 'complete', done: true })
  })

  it('ignores a chunk that is not an object', async () => {
    vi.stubGlobal('fetch', fetchMock)
    respond(sse('data: null\n\n', 'data: 7\n\n', textDelta('ok'), STOP))

    expect(await drain(new AnthropicProvider().stream(messages, 'sk-ant', options()))).toEqual(['ok'])
  })

  it('keeps a delta split across chunks', async () => {
    vi.stubGlobal('fetch', fetchMock)
    respond(sse('data: {"type":"content_block_delta","delta":{"type":"text_del', 'ta","text":"слово"}}\n\n'))

    expect(await drain(new AnthropicProvider().stream(messages, 'sk-ant', options()))).toEqual(['слово'])
  })

  it('throws the error event the stream carries', async () => {
    vi.stubGlobal('fetch', fetchMock)
    respond(sse(event({ type: 'error', error: { type: 'overloaded_error', message: 'overloaded' } })))

    await expect(drain(new AnthropicProvider().stream(messages, 'sk-ant', options()))).rejects.toThrow(
      'Ошибка Anthropic: overloaded'
    )
  })

  it.each([
    ['without a message', event({ type: 'error', error: { type: 'overloaded_error' } }), 'overloaded_error'],
    ['with only a code', event({ error: { code: 'overloaded_error' } }), 'overloaded_error'],
    ['with no detail at all', event({ type: 'error' }), 'причина не указана']
  ])('treats an error event %s as fatal', async (_case, frame, detail) => {
    vi.stubGlobal('fetch', fetchMock)
    respond(sse(frame))

    await expect(drain(new AnthropicProvider().stream(messages, 'sk-ant', options()))).rejects.toThrow(
      `Ошибка Anthropic: ${detail}`
    )
  })

  it('returns nothing for a stream that ends without message_stop', async () => {
    vi.stubGlobal('fetch', fetchMock)
    respond(sse(textDelta('a')))

    expect(await drain(new AnthropicProvider().stream(messages, 'sk-ant', options()))).toEqual(['a'])
  })

  it('returns nothing for an empty stream', async () => {
    vi.stubGlobal('fetch', fetchMock)
    respond(sse())

    expect(await drain(new AnthropicProvider().stream(messages, 'sk-ant', options()))).toEqual([])
  })
})

describe('AnthropicProvider: failures', () => {
  it('throws when the response has no body', async () => {
    vi.stubGlobal('fetch', fetchMock)
    respond(null)

    await expect(drain(new AnthropicProvider().stream(messages, 'sk-ant', options()))).rejects.toThrow(
      'Пустой ответ от Anthropic.'
    )
  })

  it('names Anthropic in a rejected key', async () => {
    vi.stubGlobal('fetch', fetchMock)
    respond(null, 401)

    await expect(drain(new AnthropicProvider().stream(messages, 'sk-ant', options()))).rejects.toThrow(
      'Ключ Anthropic не принят. Проверь ключ в настройках.'
    )
  })

  it('names Anthropic in an overloaded service', async () => {
    vi.stubGlobal('fetch', fetchMock)
    respond(null, 529)

    await expect(drain(new AnthropicProvider().stream(messages, 'sk-ant', options()))).rejects.toThrow(
      'Сервис Anthropic временно недоступен (529).'
    )
  })

  it('maps a network failure through toTransportError', async () => {
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockRejectedValue(new Error('fetch failed'))

    await expect(drain(new AnthropicProvider().stream(messages, 'sk-ant', options()))).rejects.toThrow(
      'Нет соединения с интернетом или сервис недоступен.'
    )
  })

  it('maps a connection that dies mid-stream instead of leaking the raw failure', async () => {
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockResolvedValue(new Response(brokenStream(textDelta('При'), new TypeError('terminated'))))

    await expect(drain(new AnthropicProvider().stream(messages, 'sk-ant', options()))).rejects.toThrow(
      'Нет соединения с интернетом или сервис недоступен.'
    )
  })

  it('reports a stream read cut by the abort signal as cancelled', async () => {
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()
    fetchMock.mockResolvedValue(new Response(brokenStream(textDelta('a'), new TypeError('terminated'))))

    const stream = new AnthropicProvider().stream(messages, 'sk-ant', options({ signal: controller.signal }))
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
      drain(new AnthropicProvider().stream(messages, 'sk-ant', options({ signal: controller.signal })))
    ).rejects.toThrow('Запрос отменён.')
  })
})

it.each([
  ['end_turn', STOP, 'complete'],
  ['max_tokens', STOP, 'limit'],
  ['end_turn', '', 'incomplete']
])('checks stop_reason %s and the terminal message event', async (reason, trailer, expected) => {
  vi.stubGlobal('fetch', fetchMock)
  respond(sse(textDelta('@key enter\n'), event({ type: 'message_delta', delta: { stop_reason: reason } }), trailer))
  const stream = new AnthropicProvider().stream(messages, 'key', options())
  expect(await stream.next()).toEqual({ value: { delta: '@key enter\n' }, done: false })
  expect(await stream.next()).toEqual({ value: expected, done: true })
})
