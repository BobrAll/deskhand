/**
 * Provider abstraction: one `stream()` shape over three HTTP dialects.
 * All requests happen in the main process — keys never reach a renderer.
 */

import type { ProviderId } from '@shared/types'

export type ContentPart = { type: 'text'; text: string } | { type: 'image'; mimeType: string; base64: string }

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  parts: ContentPart[]
}

export interface StreamOptions {
  model: string
  temperature: number
  maxTokens: number
  /** API root without a trailing slash, e.g. `https://api.openai.com/v1`. */
  baseUrl: string
  /** User-supplied fields merged into the request body; see `AppSettings.extraBody`. */
  extraBody?: Record<string, unknown>
  signal: AbortSignal
}

export type StreamEnd = 'complete' | 'incomplete' | 'limit'

export interface StreamChunk {
  delta: string
}

export class ProviderError extends Error {
  readonly retryable: boolean
  readonly status: number | undefined
  /**
   * The provider refused the image, not the request.
   *
   * Only ever set by `toProviderError`, from the provider's own words: a 400 or
   * 422 whose detail talks about images or multimodality. It is a separate flag
   * rather than a message match at the call site because the message is
   * localised, and matching on a translated string is how the check silently
   * stops working.
   */
  readonly imageRejected: boolean

  constructor(message: string, retryable: boolean, status?: number, imageRejected = false) {
    super(message)
    this.name = 'ProviderError'
    this.retryable = retryable
    this.status = status
    this.imageRejected = imageRejected
  }
}

export interface LlmProvider {
  id: ProviderId
  /** Yields text deltas until the model stops. */
  stream(messages: ChatMessage[], apiKey: string, options: StreamOptions): AsyncGenerator<StreamChunk, StreamEnd | void>
}
