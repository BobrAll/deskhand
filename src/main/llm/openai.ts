/**
 * OpenAI chat-completions dialect (shared by OpenAI and OpenRouter).
 */

import { traceModelUsage } from '../agent/trace'
import { ProviderError, type ChatMessage, type ContentPart, type LlmProvider, type StreamChunk, type StreamEnd, type StreamOptions } from './provider'
import {
  readSse,
  toProviderError,
  toTransportError,
  type HttpErrorBody
} from './http'

interface OpenAiPart {
  type: 'text' | 'image_url'
  text?: string
  image_url?: { url: string }
}

interface OpenAiMessage {
  role: 'system' | 'user' | 'assistant'
  content: string | OpenAiPart[]
}

export interface OpenAiCompatibleConfig {
  id: LlmProvider['id']
  label: string
  /** Fallback API root; the per-request `options.baseUrl` wins when set. */
  baseUrl: string
  extraHeaders?: Record<string, string>
}

function encodeParts(parts: ContentPart[]): string | OpenAiPart[] {
  if (parts.every((part) => part.type === 'text')) {
    return parts
      .map((part) => (part.type === 'text' ? part.text : ''))
      .join('\n\n')
      .trim()
  }
  return parts.map((part): OpenAiPart => {
    if (part.type === 'text') return { type: 'text', text: part.text }
    return {
      type: 'image_url',
      image_url: { url: `data:${part.mimeType};base64,${part.base64}` }
    }
  })
}

export class OpenAIProvider implements LlmProvider {
  readonly id: LlmProvider['id']
  private readonly label: string
  private readonly baseUrl: string
  private readonly extraHeaders: Record<string, string>

  constructor(config: OpenAiCompatibleConfig) {
    this.id = config.id
    this.label = config.label
    this.baseUrl = config.baseUrl
    this.extraHeaders = config.extraHeaders ?? {}
  }

  /** Request base URL: the per-request override wins over the built-in default. */
  private endpoint(options: StreamOptions): string {
    return (options.baseUrl || this.baseUrl).replace(/\/+$/, '')
  }

  async *stream(
    messages: ChatMessage[],
    apiKey: string,
    options: StreamOptions
  ): AsyncGenerator<StreamChunk, StreamEnd> {
    const body = {
      model: options.model,
      temperature: options.temperature,
      max_tokens: options.maxTokens,
      stream: true,
      messages: messages.map((message): OpenAiMessage => ({
        role: message.role,
        content: encodeParts(message.parts)
      }))
    }

    let response: Response
    try {
      response = await fetch(`${this.endpoint(options)}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          ...this.extraHeaders
        },
        body: JSON.stringify(body),
        signal: options.signal
      })
    } catch (error) {
      throw toTransportError(error, options.signal)
    }

    if (!response.ok) throw await toProviderError(response, this.label)
    if (!response.body) throw new ProviderError('Пустой ответ от сервиса модели.', true)

    let end: StreamEnd = 'incomplete'
    let malformed = false
    for await (const event of readSse(response.body, false)) {
      if (event.data === '[DONE]') return malformed ? 'incomplete' : end
      let parsed: unknown
      try {
        parsed = JSON.parse(event.data)
      } catch {
        malformed = true
        continue
      }
      const payload = parsed as {
        choices?: Array<{ delta?: { content?: string | null }; finish_reason?: string | null }>
        error?: HttpErrorBody['error']
        usage?: { prompt_tokens?: number; completion_tokens?: number }
      }
      if (payload.error?.message) {
        throw new ProviderError(`Ошибка модели: ${payload.error.message}`, true)
      }
      if (payload.usage) traceModelUsage(payload.usage.prompt_tokens, payload.usage.completion_tokens)
      const reason = payload.choices?.[0]?.finish_reason
      if (reason) end = reason === 'stop' ? 'complete' : reason === 'length' ? 'limit' : 'incomplete'
      const delta = payload.choices?.[0]?.delta?.content
      if (delta) yield { delta }
    }
    return 'incomplete'
  }
}
