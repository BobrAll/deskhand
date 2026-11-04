/**
 * Provider abstraction: one `stream()` shape over three HTTP dialects.
 * All requests happen in the main process — keys never reach a renderer.
 */

import type { ProviderId } from '@shared/types'

export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; mimeType: string; base64: string }

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
  signal: AbortSignal
}

export interface StreamChunk {
  delta: string
}

export interface StreamFailure {
  /** Human readable, already localised for the overlay. */
  message: string
  retryable: boolean
  status?: number
}

export class ProviderError extends Error {
  readonly retryable: boolean
  readonly status: number | undefined

  constructor(message: string, retryable: boolean, status?: number) {
    super(message)
    this.name = 'ProviderError'
    this.retryable = retryable
    this.status = status
  }
}

export interface LlmProvider {
  id: ProviderId
  /** Yields text deltas until the model stops. */
  stream(messages: ChatMessage[], apiKey: string, options: StreamOptions): AsyncGenerator<StreamChunk>
}