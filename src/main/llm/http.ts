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

const EVENT_SEPARATOR = /\r?\n\r?\n/

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
      for (;;) {
        const boundary = EVENT_SEPARATOR.exec(buffer)
        if (!boundary) break
        const raw = buffer.slice(0, boundary.index)
        buffer = buffer.slice(boundary.index + boundary[0].length)
        const parsed = parseBlock(raw)
        if (parsed) yield parsed
      }
    }
    const tail = allowTail ? parseBlock(buffer) : null
    if (tail) yield tail
  } finally {
    // An early stop abandons the rest of the body, so the socket waits for the
    // garbage collector unless it is cancelled here. A body that already failed
    // has nothing to cancel, and that failure is not this one.
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

/**
 * `readSse` for a provider response: a failure while reading the body is a
 * transport failure, not a bug in the decoder.
 *
 * The request has already succeeded by the time the body arrives, so a
 * connection that dies halfway used to escape as a raw `TypeError: terminated`
 * and reach the card in English. Provider errors are already ours and pass
 * through unchanged.
 */
export async function* readProviderSse(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal
): AsyncGenerator<SseEvent> {
  try {
    yield* readSse(body, false)
  } catch (error) {
    if (error instanceof ProviderError) throw error
    throw toTransportError(error, signal)
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
 * The provider's own words for a streamed error, in the order it uses them.
 *
 * Some providers send only a type (`overloaded_error`), and treating such an
 * event as if it carried nothing would end the turn with an empty answer and no
 * error at all. A body with no usable text still counts as fatal; it just says
 * so.
 */
export function providerErrorMessage(error: unknown): string {
  const text = (value: unknown): string | undefined =>
    typeof value === 'string' && value.trim() ? value.trim() : undefined
  if (typeof error === 'string') return text(error) ?? 'причина не указана'
  if (!error || typeof error !== 'object') return 'причина не указана'
  const { message, type, code } = error as { message?: unknown; type?: unknown; code?: unknown }
  return text(message) ?? text(type) ?? text(code) ?? 'причина не указана'
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
  const detail = await readErrorDetail(response)
  const status = response.status
  const described = describeProviderStatus(status, { label: providerLabel, detail })
  return new ProviderError(
    described.message,
    described.retryable,
    status,
    (status === 400 || status === 422) && IMAGE_REJECTION.test(detail)
  )
}

/**
 * The provider's own words from a failed response, or an empty string.
 *
 * Only the message is wanted: the enclosing sentence is ours. A body that is not
 * JSON is cut to a preview, and a body that cannot be read at all is not an error
 * of its own — the status already told the story.
 */
async function readErrorDetail(response: Response): Promise<string> {
  try {
    const text = await response.text()
    if (!text) return ''
    try {
      const body = JSON.parse(text) as HttpErrorBody
      return body.error?.message ?? body.message ?? ''
    } catch {
      return text.slice(0, 300)
    }
  } catch {
    return ''
  }
}

/** Maps a fetch/abort failure to a user-facing message. */
export function toTransportError(error: unknown, signal: AbortSignal): ProviderError {
  if (signal.aborted) {
    return new ProviderError('Запрос отменён.', false)
  }
  const message = error instanceof Error ? error.message : String(error)
  if (/abort/i.test(message)) return new ProviderError('Запрос отменён.', false)
  if (/ENOTFOUND|EAI_AGAIN|ENETUNREACH|ECONNRESET|EPIPE|fetch failed|network|terminated|socket hang up|other side closed/i.test(message)) {
    return new ProviderError('Нет соединения с интернетом или сервис недоступен.', true)
  }
  if (/timeout|timed out/i.test(message)) {
    return new ProviderError('Превышено время ожидания ответа модели.', true)
  }
  return new ProviderError(`Не удалось выполнить запрос: ${message}`, true)
}
