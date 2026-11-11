/**
 * Shared HTTP/SSE plumbing for the OpenAI-compatible providers.
 */

import { ProviderError, type StreamOptions } from './provider'
import { describeProviderStatus } from './statusText'

/** Request base URL: the per-request override wins over the built-in default. */
export function apiRoot(options: StreamOptions, fallback: string): string {
  return options.baseUrl || fallback
}

export function apiEndpoint(baseUrl: string, path: string): URL {
  const endpoint = new URL(baseUrl)
  endpoint.pathname = endpoint.pathname.replace(/\/+$/, '') + '/' + path
  endpoint.hash = ''
  return endpoint
}

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

/**
 * The provider's own words for "this model cannot take an image".
 *
 * There is no standard code for it: OpenAI-compatible servers answer 400 with
 * prose, Anthropic answers 400 with a type, proxies invent their own. The
 * phrases below are the ones actually seen; a miss costs a failed turn, not
 * silence, because the caller falls back to the ordinary error path.
 */
const IMAGE_REJECTION = /image|vision|multimodal|modality|content[-_ ]?type/i

/**
 * Turns a non-2xx response into a localised, actionable error.
 *
 * `imageRejected` is set when the body blames the image: the caller then retries
 * the same turn without it, which is the only way to know for certain — the user
 * names the model, and it may be one we have never heard of.
 */
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
  const described = describeProviderStatus(status, { label: providerLabel, detail })
  return new ProviderError(
    described.message,
    described.retryable,
    status,
    (status === 400 || status === 422) && IMAGE_REJECTION.test(detail)
  )
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
