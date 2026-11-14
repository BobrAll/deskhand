/**
 * OpenAI chat-completions dialect (shared by OpenAI and OpenRouter).
 */

import { traceModelUsage } from '../agent/trace'
import { disabledReasoning, isReasoningModel } from './reasoning'
import { ProviderError, type ChatMessage, type ContentPart, type LlmProvider, type StreamChunk, type StreamEnd, type StreamOptions } from './provider'
import {
  apiEndpoint,
  apiRoot,
  providerErrorMessage,
  readProviderSse,
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

/** One `data:` payload of a streamed chat completion. */
interface OpenAiChunk {
  choices?: Array<{ delta?: { content?: string | null }; finish_reason?: string | null }>
  error?: HttpErrorBody['error']
  usage?: { prompt_tokens?: number; completion_tokens?: number }
}

export interface OpenAiCompatibleConfig {
  id: LlmProvider['id']
  label: string
  /** Fallback API root; the per-request `options.baseUrl` wins when set. */
  baseUrl: string
  extraHeaders?: Record<string, string>
}

function encodeBlocks(parts: ContentPart[]): string | OpenAiPart[] {
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

/** `finish_reason` in the words the caller knows. */
function streamEnd(reason: string): StreamEnd {
  if (reason === 'stop') return 'complete'
  if (reason === 'length') return 'limit'
  return 'incomplete'
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

  async *stream(
    messages: ChatMessage[],
    apiKey: string,
    options: StreamOptions
  ): AsyncGenerator<StreamChunk, StreamEnd> {
    const body = await this.openStream(messages, apiKey, options)
    let end: StreamEnd = 'incomplete'
    for await (const event of readProviderSse(body, options.signal)) {
      // Termination comes from `[DONE]` and `finish_reason` only: an event this
      // decoder skips must not decide that an otherwise finished turn is broken.
      if (event.data === '[DONE]') return end
      let parsed: unknown
      try {
        parsed = JSON.parse(event.data)
      } catch {
        continue
      }
      if (!parsed || typeof parsed !== 'object') continue
      const payload = parsed as OpenAiChunk
      if (payload.error) {
        throw new ProviderError(`Ошибка модели: ${providerErrorMessage(payload.error)}`, true)
      }
      if (payload.usage) traceModelUsage(payload.usage.prompt_tokens, payload.usage.completion_tokens)
      const reason = payload.choices?.[0]?.finish_reason
      if (reason) end = streamEnd(reason)
      const delta = payload.choices?.[0]?.delta?.content
      if (delta) yield { delta }
    }
    return 'incomplete'
  }

  private payload(messages: ChatMessage[], options: StreamOptions): object {
    // Reasoning models reject `max_tokens` and a non-default temperature; their
    // limit travels as `max_completion_tokens` instead.
    const reasoning = isReasoningModel(options.model)
    return {
      model: options.model,
      ...(reasoning
        ? { max_completion_tokens: options.maxTokens }
        : { temperature: options.temperature, max_tokens: options.maxTokens }),
      ...disabledReasoning(apiRoot(options, this.baseUrl), options.model),
      // Without this the stream carries no usage at all, and `traceModelUsage`
      // never sees a token count on the OpenAI wire. A caller that sets its own
      // `stream_options` in `extraBody` wins, and a gateway that rejects the
      // field can be opted out of the same way.
      stream_options: { include_usage: true },
      ...options.extraBody,
      stream: true,
      messages: messages.map((message): OpenAiMessage => ({
        role: message.role,
        content: encodeBlocks(message.parts)
      }))
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
      response = await fetch(apiEndpoint(apiRoot(options, this.baseUrl), 'chat/completions').href, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          ...this.extraHeaders
        },
        body: JSON.stringify(this.payload(messages, options)),
        signal: options.signal
      })
    } catch (error) {
      throw toTransportError(error, options.signal)
    }

    if (!response.ok) throw await toProviderError(response, this.label)
    if (!response.body) throw new ProviderError('Пустой ответ от сервиса модели.', true)
    return response.body
  }
}
