/**
 * Anthropic Messages API. Different enough from OpenAI (system prompt is a
 * top-level field, images use a `source` object, SSE carries typed events) that
 * it gets its own implementation.
 */

import {
  ProviderError,
  type ChatMessage,
  type ContentPart,
  type LlmProvider,
  type StreamChunk,
  type StreamOptions
} from './provider'
import { readSse, toProviderError, toTransportError } from './http'

type AnthropicBlock =
  | { type: 'text'; text: string }
  | {
      type: 'image'
      source: { type: 'base64'; media_type: string; data: string }
    }

interface AnthropicMessage {
  role: 'user' | 'assistant'
  content: AnthropicBlock[]
}

function encodeBlocks(parts: ContentPart[]): AnthropicBlock[] {
  return parts.map((part): AnthropicBlock => {
    if (part.type === 'text') return { type: 'text', text: part.text }
    return {
      type: 'image',
      source: { type: 'base64', media_type: part.mimeType, data: part.base64 }
    }
  })
}

export class AnthropicProvider implements LlmProvider {
  readonly id = 'anthropic' as const

  private readonly baseUrl: string

  constructor(baseUrl = 'https://api.anthropic.com/v1') {
    this.baseUrl = baseUrl
  }

  /** Request base URL: the per-request override wins over the built-in default. */
  private endpoint(options: StreamOptions): string {
    return (options.baseUrl || this.baseUrl).replace(/\/+$/, '')
  }

  async *stream(
    messages: ChatMessage[],
    apiKey: string,
    options: StreamOptions
  ): AsyncGenerator<StreamChunk> {
    const system = messages
      .filter((message) => message.role === 'system')
      .flatMap((message) => message.parts)
      .map((part) => (part.type === 'text' ? part.text : ''))
      .join('\n\n')
      .trim()

    const turns = messages
      .filter((message): message is ChatMessage & { role: 'user' | 'assistant' } =>
        message.role !== 'system'
      )
      .map(
        (message): AnthropicMessage => ({
          role: message.role,
          content: encodeBlocks(message.parts)
        })
      )

    const body = {
      model: options.model,
      max_tokens: options.maxTokens,
      temperature: options.temperature,
      ...(system ? { system } : {}),
      messages: turns,
      stream: true
    }

    let response: Response
    try {
      response = await fetch(`${this.endpoint(options)}/messages`, {
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json'
        },
        body: JSON.stringify(body),
        signal: options.signal
      })
    } catch (error) {
      throw toTransportError(error, options.signal)
    }

    if (!response.ok) throw await toProviderError(response, 'Anthropic')
    if (!response.body) throw new ProviderError('Пустой ответ от Anthropic.', true)

    for await (const event of readSse(response.body)) {
      let parsed: unknown
      try {
        parsed = JSON.parse(event.data)
      } catch {
        continue
      }
      const payload = parsed as {
        type?: string
        delta?: { type?: string; text?: string }
        error?: { message?: string }
      }
      if (payload.type === 'error' && payload.error?.message) {
        throw new ProviderError(`Ошибка Anthropic: ${payload.error.message}`, true)
      }
      if (payload.type === 'content_block_delta' && payload.delta?.type === 'text_delta') {
        if (payload.delta.text) yield { delta: payload.delta.text }
      }
      if (payload.type === 'message_stop') return
    }
  }
}