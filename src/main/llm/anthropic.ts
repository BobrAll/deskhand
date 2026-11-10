/**
 * Anthropic Messages API. Different enough from OpenAI (system prompt is a
 * top-level field, images use a `source` object, SSE carries typed events) that
 * it gets its own implementation.
 */

import { traceModelUsage } from '../agent/trace'
import {
  ProviderError,
  type ChatMessage,
  type ContentPart,
  type LlmProvider,
  type StreamChunk, type StreamEnd,
  type StreamOptions
} from './provider'
import { apiRoot, readSse, toProviderError, toTransportError } from './http'

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

  async *stream(
    messages: ChatMessage[],
    apiKey: string,
    options: StreamOptions
  ): AsyncGenerator<StreamChunk, StreamEnd> {
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
      thinking: { type: 'disabled' as const },
      ...options.extraBody,
      ...(system ? { system } : {}),
      messages: turns,
      stream: true
    }

    let response: Response
    try {
      response = await fetch(`${apiRoot(options, this.baseUrl)}/messages`, {
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

    let end: StreamEnd = 'incomplete'
    let malformed = false
    let inputTokens: number | undefined
    let outputTokens: number | undefined
    for await (const event of readSse(response.body, false)) {
      let parsed: unknown
      try {
        parsed = JSON.parse(event.data)
      } catch {
        malformed = true
        continue
      }
      const payload = parsed as {
        type?: string
        delta?: { type?: string; text?: string; stop_reason?: string }
        error?: { message?: string }
        message?: { usage?: { input_tokens?: number; output_tokens?: number } }
        usage?: { output_tokens?: number }
      }
      if (payload.type === 'error' && payload.error?.message) {
        throw new ProviderError(`Ошибка Anthropic: ${payload.error.message}`, true)
      }
      if (payload.type === 'content_block_delta' && payload.delta?.type === 'text_delta') {
        if (payload.delta.text) yield { delta: payload.delta.text }
      }
      if (payload.type === 'message_start') {
        inputTokens = payload.message?.usage?.input_tokens
        outputTokens = payload.message?.usage?.output_tokens
      }
      if (payload.type === 'message_delta') outputTokens = payload.usage?.output_tokens ?? outputTokens
      if (payload.type === 'message_delta' && payload.delta?.stop_reason) {
        const reason = payload.delta.stop_reason
        end = reason === 'end_turn' || reason === 'stop_sequence' ? 'complete'
          : reason === 'max_tokens' ? 'limit' : 'incomplete'
      }
      if (payload.type === 'message_stop') {
        traceModelUsage(inputTokens, outputTokens)
        return malformed ? 'incomplete' : end
      }
    }
    return 'incomplete'
  }
}
