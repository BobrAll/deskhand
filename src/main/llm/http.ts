/**
 * Shared HTTP/SSE plumbing for the OpenAI-compatible providers.
 */

import { ProviderError } from './provider'

export interface SseEvent {
  event?: string
  data: string
}

/** Parses a raw `text/event-stream` body into events. */
export async function* readSse(body: ReadableStream<Uint8Array>, allowTail = true): AsyncGenerator<SseEvent> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let boundary = /\r?\n\r?\n/.exec(buffer)
      while (boundary) {
        const raw = buffer.slice(0, boundary.index)
        buffer = buffer.slice(boundary.index + boundary[0].length)
        const parsed = parseBlock(raw)
        if (parsed) yield parsed
        boundary = /\r?\n\r?\n/.exec(buffer)
      }
    }
    const tail = allowTail ? parseBlock(buffer) : null
    if (tail) yield tail
  } finally {
    reader.releaseLock()
  }
}

function parseBlock(raw: string): SseEvent | null {
  const lines = raw.split(/\r?\n/)
  let event: string | undefined
  const data: string[] = []
  for (const line of lines) {
    if (!line || line.startsWith(':')) continue
    if (line.startsWith('event:')) event = line.slice(6).trim()
    else if (line.startsWith('data:')) data.push(line.slice(5).trimStart())
  }
  if (data.length === 0) return null
  const payload = data.join('\n')
  return event ? { event, data: payload } : { data: payload }
}

export interface HttpErrorBody {
  message?: string
  error?: { message?: string; type?: string; code?: string }
}

/** Turns a non-2xx response into a localised, actionable error. */
export async function toProviderError(response: Response, providerLabel: string): Promise<ProviderError> {
  let detail = ''
  try {
    const text = await response.text()
    if (text) {
      try {
        const body = JSON.parse(text) as HttpErrorBody
        detail = body.error?.message ?? body.message ?? ''
      } catch {
        detail = text.slice(0, 300)
      }
    }
  } catch {
    /* ignore */
  }

  const status = response.status
  switch (status) {
    case 401:
    case 403:
      return new ProviderError(
        `Ключ ${providerLabel} не принят. Проверьте ключ в настройках.`,
        false,
        status
      )
    case 402:
      return new ProviderError(`Недостаточно средств на счёте ${providerLabel}.`, false, status)
    case 404:
      return new ProviderError(
        `Модель не найдена у ${providerLabel}. Проверьте название модели.${detail ? ` (${detail})` : ''}`,
        false,
        status
      )
    case 413:
      return new ProviderError('Контекст слишком большой: уменьшите скриншот или выделение.', false, status)
    case 429:
      return new ProviderError(
        `Лимит запросов ${providerLabel} исчерпан. Подождите немного и повторите.`,
        true,
        status
      )
    default:
      if (status >= 500) {
        return new ProviderError(`Сервис ${providerLabel} временно недоступен (${status}).`, true, status)
      }
      return new ProviderError(
        `Ошибка ${providerLabel} (${status})${detail ? `: ${detail}` : ''}`,
        true,
        status
      )
  }
}

/** Maps a fetch/abort failure to a user-facing message. */
export function toTransportError(error: unknown, signal: AbortSignal): ProviderError {
  if (signal.aborted) {
    return new ProviderError('Запрос отменён.', false)
  }
  const message = error instanceof Error ? error.message : String(error)
  if (/abort/i.test(message)) return new ProviderError('Запрос отменён.', false)
  if (/ENOTFOUND|EAI_AGAIN|ENETUNREACH|fetch failed|network/i.test(message)) {
    return new ProviderError('Нет соединения с интернетом или сервис недоступен.', true)
  }
  if (/timeout|timed out/i.test(message)) {
    return new ProviderError('Превышено время ожидания ответа модели.', true)
  }
  return new ProviderError(`Не удалось выполнить запрос: ${message}`, true)
}