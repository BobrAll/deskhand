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
  type StreamChunk,
  type StreamEnd,
  type StreamOptions
} from './provider'
import {
  apiEndpoint,
  apiRoot,
  parseSseJson,
  providerErrorMessage,
  readProviderSse,
  toProviderError,
  toTransportError
} from './http'

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

/** One `data:` payload of a streamed message. */
interface AnthropicEvent {
  type?: string
  delta?: { type?: string; text?: string; stop_reason?: string }
  error?: { message?: string; type?: string; code?: string }
  message?: { usage?: { input_tokens?: number; output_tokens?: number } }
  usage?: { output_tokens?: number }
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

/** `stop_reason` in the words the caller knows. */
function streamEnd(reason: string): StreamEnd {
  if (reason === 'end_turn' || reason === 'stop_sequence') return 'complete'
  if (reason === 'max_tokens') return 'limit'
  return 'incomplete'
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
    const body = await this.openStream(messages, apiKey, options)
    let end: StreamEnd = 'incomplete'
    let inputTokens: number | undefined
    let outputTokens: number | undefined
    for await (const event of readProviderSse(body, options.signal)) {
      const payload = parseSseJson<AnthropicEvent>(event)
      if (!payload) continue
      // Any error event is fatal, even one that names only its type: an empty
      // answer with no error is worse than a vague one.
      if (payload.error || payload.type === 'error') {
        throw new ProviderError(`Ошибка Anthropic: ${providerErrorMessage(payload.error)}`, true)
      }
      if (payload.type === 'content_block_delta' && payload.delta?.type === 'text_delta') {
        if (payload.delta.text) yield { delta: payload.delta.text }
      }
      if (payload.type === 'message_start') {
        inputTokens = payload.message?.usage?.input_tokens
        outputTokens = payload.message?.usage?.output_tokens
      }
      if (payload.type === 'message_delta') {
        outputTokens = payload.usage?.output_tokens ?? outputTokens
        if (payload.delta?.stop_reason) end = streamEnd(payload.delta.stop_reason)
      }
      if (payload.type === 'message_stop') {
        traceModelUsage(inputTokens, outputTokens)
        // Termination comes from `message_stop` and `stop_reason` only: an event
        // this decoder skips must not decide that a finished turn is broken.
        return end
      }
    }
    return 'incomplete'
  }

  private payload(messages: ChatMessage[], options: StreamOptions): object {
    const system = messages
      .filter((message) => message.role === 'system')
      .flatMap((message) => message.parts)
      .map((part) => (part.type === 'text' ? part.text : ''))
      .join('\n\n')
      .trim()

    const turns = messages
      .filter((message): message is ChatMessage & { role: 'user' | 'assistant' } => message.role !== 'system')
      .map((message): AnthropicMessage => ({
        role: message.role,
        content: encodeBlocks(message.parts)
      }))

    return {
      model: options.model,
      max_tokens: options.maxTokens,
      temperature: options.temperature,
      thinking: { type: 'disabled' as const },
      ...options.extraBody,
      ...(system ? { system } : {}),
      messages: turns,
      stream: true
    }
  }

  /** Sends the turn and returns its event stream, or throws a mapped error. */
  private async openStream(
    messages: ChatMessage[],
    apiKey: string,
    options: StreamOptions
  ): Promise<ReadableStream<Uint8Array>> {
    let response: Response
    try {
      response = await fetch(apiEndpoint(apiRoot(options, this.baseUrl), 'messages').href, {
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json'
        },
        body: JSON.stringify(this.payload(messages, options)),
        signal: options.signal
      })
    } catch (error) {
      throw toTransportError(error, options.signal)
    }

    if (!response.ok) throw await toProviderError(response, 'Anthropic')
    if (!response.body) throw new ProviderError('Пустой ответ от Anthropic.', true)
    return response.body
  }
}
