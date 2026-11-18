import { describe, expect, it, vi } from 'vitest'

import { ProviderError } from './provider'
import { providerErrorMessage, readSse, toProviderError, toTransportError } from './http'

/** A `text/event-stream` body delivered as the given chunks, in order. */
function body(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    }
  })
}

async function collect(chunks: string[]): Promise<Array<{ event?: string; data: string }>> {
  const events: Array<{ event?: string; data: string }> = []
  for await (const event of readSse(body(chunks))) events.push(event)
  return events
}

describe('readSse: the event stream', () => {
  it('reads one event per blank line', async () => {
    const events = await collect(['data: {"a":1}\n\ndata: {"b":2}\n\n'])
    expect(events).toEqual([{ data: '{"a":1}' }, { data: '{"b":2}' }])
  })

  it('emits nothing for an empty body', async () => {
    expect(await collect([])).toEqual([])
    expect(await collect([''])).toEqual([])
    expect(await collect(['\n\n'])).toEqual([])
  })

  it('yields a final event that has no trailing blank line', async () => {
    expect(await collect(['data: tail'])).toEqual([{ data: 'tail' }])
    expect(await collect(['data: tail\n'])).toEqual([{ data: 'tail' }])
  })

  it('keeps a chunk boundary in the middle of an event from splitting it', async () => {
    const whole = await collect(['data: {"delta":"привет"}\n\n'])
    const byChar = await collect('data: {"delta":"привет"}\n\n'.split(''))
    const byTwo = await collect(('data: {"delta":"привет"}\n\n' + 'data: [DONE]\n\n').match(/[\s\S]{1,2}/g) ?? [])

    expect(byChar).toEqual(whole)
    expect(byTwo).toEqual([{ data: '{"delta":"привет"}' }, { data: '[DONE]' }])
  })

  it('keeps a boundary that falls exactly on the separator', async () => {
    const events = await collect(['data: a\n', '\ndata: b\n\n'])
    expect(events).toEqual([{ data: 'a' }, { data: 'b' }])
  })

  it('keeps a boundary that falls inside the two newlines', async () => {
    const events = await collect(['data: a\n\n', 'data: b\n\n'])
    expect(events).toEqual([{ data: 'a' }, { data: 'b' }])
  })

  it('splits a multi-byte character across chunks without corrupting it', async () => {
    const bytes = new TextEncoder().encode('data: «привет»\n\n')
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        // One byte per chunk: every Cyrillic letter and every «» is split.
        for (const byte of bytes) controller.enqueue(new Uint8Array([byte]))
        controller.close()
      }
    })
    const events: Array<{ data: string }> = []
    for await (const event of readSse(stream)) events.push(event)
    expect(events).toEqual([{ data: '«привет»' }])
  })

  it('ignores comment lines starting with a colon', async () => {
    const events = await collect([': keep-alive\n\ndata: real\n\n: ping\n\n'])
    expect(events).toEqual([{ data: 'real' }])
  })

  it('ignores an empty line inside a block', async () => {
    // A blank line is the separator, so it never reaches the block parser; the
    // parser also skips empty lines defensively.
    expect(await collect([': comment only\n\n'])).toEqual([])
  })

  it('reads the event name', async () => {
    expect(await collect(['event: message\ndata: hi\n\n'])).toEqual([{ event: 'message', data: 'hi' }])
    expect(await collect(['event:  message  \ndata: hi\n\n'])).toEqual([{ event: 'message', data: 'hi' }])
  })

  it('joins several data lines with a newline', async () => {
    expect(await collect(['data: one\ndata: two\n\n'])).toEqual([{ data: 'one\ntwo' }])
  })

  it('trims the leading spaces after `data:` but keeps the rest', async () => {
    expect(await collect(['data:  spaced  \n\n'])).toEqual([{ data: 'spaced  ' }])
    expect(await collect(['data:nospace\n\n'])).toEqual([{ data: 'nospace' }])
    expect(await collect(['data:\n\n'])).toEqual([{ data: '' }])
  })

  it('ignores lines that are neither `event:` nor `data:`', async () => {
    expect(await collect(['id: 7\nretry: 100\ndata: kept\n\n'])).toEqual([{ data: 'kept' }])
  })

  it('frames CRLF events even when the separator crosses chunks', async () => {
    const events = await collect(['data: a\r', '\n\r\ndata: b\r\n\r\n'])
    expect(events).toEqual([{ data: 'a' }, { data: 'b' }])
  })

  it('releases the reader lock when the consumer stops early', async () => {
    const stream = body(['data: a\n\ndata: b\n\n'])
    for await (const event of readSse(stream)) {
      expect(event.data).toBe('a')
      break
    }
    // A second pass must not throw: the lock was released in `finally`.
    const again = await collect(['data: c\n\n'])
    expect(again).toEqual([{ data: 'c' }])
  })

  it('cancels the body a consumer abandoned', async () => {
    const cancel = vi.fn()
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: a\n\ndata: b\n\n'))
      },
      cancel
    })

    for await (const event of readSse(stream)) {
      expect(event.data).toBe('a')
      break
    }

    expect(cancel).toHaveBeenCalledTimes(1)
  })

  it('survives a cancel that fails', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: a\n\n'))
      },
      cancel() {
        return Promise.reject(new Error('already gone'))
      }
    })

    for await (const event of readSse(stream)) {
      expect(event.data).toBe('a')
      break
    }
  })
})

describe('toProviderError: the status map', () => {
  async function errorFor(status: number, text = '', label = 'OpenAI'): Promise<ProviderError> {
    return toProviderError(new Response(text, { status }), label)
  }

  it('maps 401 to a rejected key', async () => {
    const error = await errorFor(401)
    expect(error.message).toBe('Ключ OpenAI не принят. Проверь ключ в настройках.')
    expect(error.retryable).toBe(false)
    expect(error.status).toBe(401)
  })

  it('maps 403 the same way as 401', async () => {
    const error = await errorFor(403)
    expect(error.message).toBe('Ключ OpenAI не принят. Проверь ключ в настройках.')
    expect(error.retryable).toBe(false)
    expect(error.status).toBe(403)
  })

  it('maps 402 to a balance problem', async () => {
    const error = await errorFor(402)
    expect(error.message).toBe('Ключ OpenAI действителен, но на счёте нет средств.')
    expect(error.retryable).toBe(false)
    expect(error.status).toBe(402)
  })

  it('maps 404 to a model name problem', async () => {
    const error = await errorFor(404)
    expect(error.message).toBe('Модель не найдена у OpenAI. Проверь название модели.')
    expect(error.retryable).toBe(false)
  })

  it('maps 413 to a context size problem', async () => {
    const error = await errorFor(413)
    expect(error.message).toBe('Контекст слишком большой: уменьши скриншот или выделение.')
    expect(error.retryable).toBe(false)
  })

  it('maps 429 to a rate limit, and marks it retryable', async () => {
    const error = await errorFor(429)
    expect(error.message).toBe('Ключ OpenAI действителен, но лимит запросов исчерпан. Попробуй позже.')
    expect(error.retryable).toBe(true)
    expect(error.status).toBe(429)
  })

  it('maps any 5xx to a temporary outage, and marks it retryable', async () => {
    for (const status of [500, 502, 503, 504, 599]) {
      const error = await errorFor(status)
      expect(error.message, String(status)).toBe(`Сервис OpenAI временно недоступен (${status}).`)
      expect(error.retryable, String(status)).toBe(true)
      expect(error.status, String(status)).toBe(status)
    }
  })

  it('falls back to a generic, retryable error for anything else', async () => {
    const error = await errorFor(400)
    expect(error.message).toBe('Ошибка OpenAI (400)')
    expect(error.retryable).toBe(true)
    expect(error.status).toBe(400)
  })

  it('substitutes the provider label it is given', async () => {
    expect((await errorFor(401, '', 'OpenRouter')).message).toBe(
      'Ключ OpenRouter не принят. Проверь ключ в настройках.'
    )
  })
})

describe('toProviderError: the detail in the body', () => {
  it('reads `error.message` from a JSON body', async () => {
    const text = JSON.stringify({ error: { message: 'model not found', type: 'x' } })
    const error = await toProviderError(new Response(text, { status: 404 }), 'OpenAI')
    expect(error.message).toBe('Модель не найдена у OpenAI. Проверь название модели. (model not found)')
  })

  it('falls back to a top-level `message`', async () => {
    const text = JSON.stringify({ message: 'bad thing' })
    const error = await toProviderError(new Response(text, { status: 404 }), 'OpenAI')
    expect(error.message).toContain('(bad thing)')
  })

  it('prefers `error.message` over the top-level `message`', async () => {
    const text = JSON.stringify({ message: 'outer', error: { message: 'inner' } })
    const error = await toProviderError(new Response(text, { status: 404 }), 'OpenAI')
    expect(error.message).toContain('(inner)')
    expect(error.message).not.toContain('outer')
  })

  it('uses the raw text, cut to 300 characters, when the body is not JSON', async () => {
    const long = 'x'.repeat(400)
    const error = await toProviderError(new Response(long, { status: 404 }), 'OpenAI')
    expect(error.message).toContain(`(${'x'.repeat(300)})`)
  })

  it('adds no parentheses when the body is empty', async () => {
    const error = await toProviderError(new Response('', { status: 404 }), 'OpenAI')
    expect(error.message).toBe('Модель не найдена у OpenAI. Проверь название модели.')
  })

  it('appends the detail to the generic error with a colon', async () => {
    const error = await toProviderError(
      new Response(JSON.stringify({ error: { message: 'nope' } }), { status: 400 }),
      'OpenAI'
    )
    expect(error.message).toBe('Ошибка OpenAI (400): nope')
  })

  it('ignores the body for statuses whose text is fixed', async () => {
    const text = JSON.stringify({ error: { message: 'secret detail' } })
    for (const status of [401, 402, 413, 429, 503]) {
      const error = await toProviderError(new Response(text, { status }), 'OpenAI')
      expect(error.message, String(status)).not.toContain('secret detail')
    }
  })

  it('survives a body that cannot be read', async () => {
    const broken = {
      status: 400,
      text: () => Promise.reject(new Error('stream closed'))
    } as unknown as Response
    const error = await toProviderError(broken, 'OpenAI')
    expect(error.message).toBe('Ошибка OpenAI (400)')
  })
})

describe('providerErrorMessage', () => {
  it('prefers the message, then the type, then the code', () => {
    expect(providerErrorMessage({ message: 'overloaded', type: 'x', code: 'y' })).toBe('overloaded')
    expect(providerErrorMessage({ type: 'overloaded_error', code: 'y' })).toBe('overloaded_error')
    expect(providerErrorMessage({ code: 'insufficient_quota' })).toBe('insufficient_quota')
  })

  it('keeps a string error', () => {
    expect(providerErrorMessage('overloaded')).toBe('overloaded')
  })

  it('still says something when the provider said nothing', () => {
    expect(providerErrorMessage({})).toBe('причина не указана')
    expect(providerErrorMessage(undefined)).toBe('причина не указана')
    expect(providerErrorMessage({ message: '   ' })).toBe('причина не указана')
  })
})

describe('toTransportError', () => {
  function signal(aborted = false): AbortSignal {
    const controller = new AbortController()
    if (aborted) controller.abort()
    return controller.signal
  }

  it('reports a cancelled request when the signal is aborted', () => {
    const error = toTransportError(new Error('anything'), signal(true))
    expect(error.message).toBe('Запрос отменён.')
    expect(error.retryable).toBe(false)
  })

  it('reports a cancelled request when the message says abort', () => {
    for (const message of ['AbortError', 'The operation was aborted', 'ABORTED']) {
      const error = toTransportError(new Error(message), signal())
      expect(error.message, message).toBe('Запрос отменён.')
      expect(error.retryable, message).toBe(false)
    }
  })

  it('reports a network problem as retryable', () => {
    for (const message of [
      'getaddrinfo ENOTFOUND api.openai.com',
      'EAI_AGAIN',
      'ENETUNREACH',
      'ECONNRESET',
      'EPIPE',
      'fetch failed',
      'network error',
      // What undici throws when the connection dies mid-body.
      'terminated',
      'socket hang up',
      'other side closed'
    ]) {
      const error = toTransportError(new Error(message), signal())
      expect(error.message, message).toBe('Нет соединения с интернетом или сервис недоступен.')
      expect(error.retryable, message).toBe(true)
    }
  })

  it('reports a timeout as retryable', () => {
    for (const message of ['timeout', 'request timed out']) {
      const error = toTransportError(new Error(message), signal())
      expect(error.message, message).toBe('Превышено время ожидания ответа модели.')
      expect(error.retryable, message).toBe(true)
    }
  })

  it('passes an unknown failure through, with a prefix', () => {
    const error = toTransportError(new Error('boom'), signal())
    expect(error.message).toBe('Не удалось выполнить запрос: boom')
    expect(error.retryable).toBe(true)
  })

  it('stringifies a non-Error failure', () => {
    expect(toTransportError('weird', signal()).message).toBe('Не удалось выполнить запрос: weird')
    expect(toTransportError(42, signal()).message).toBe('Не удалось выполнить запрос: 42')
  })

  it('checks the abort signal before the message', () => {
    // A cancelled request that also looks like a network error is still a cancel.
    const error = toTransportError(new Error('fetch failed'), signal(true))
    expect(error.message).toBe('Запрос отменён.')
    expect(error.retryable).toBe(false)
  })

  it('leaves the status undefined: a transport failure has no HTTP code', () => {
    expect(toTransportError(new Error('boom'), signal()).status).toBeUndefined()
  })

  it('returns a ProviderError so callers can read retryable and status', () => {
    expect(toTransportError(new Error('boom'), signal())).toBeInstanceOf(ProviderError)
  })
})
