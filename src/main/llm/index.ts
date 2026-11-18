/**
 * Provider registry: one entry point that turns provider settings into a
 * streaming LLM implementation.
 */

import type { AppSettings, ProviderId } from '@shared/types'
import { AnthropicProvider } from './anthropic'
import { OpenAIProvider } from './openai'
import { OpenRouterProvider } from './openrouter'
import type { LlmProvider } from './provider'

const registry: Record<ProviderId, LlmProvider> = {
  openrouter: new OpenRouterProvider(),
  openai: new OpenAIProvider({
    id: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1'
  }),
  anthropic: new AnthropicProvider()
}

export function getProvider(id: ProviderId): LlmProvider {
  return registry[id]
}

export function resolveChatModel(settings: AppSettings): string {
  // The model is the user's to name. There is no built-in default: an id shipped
  // in the build is a guess about an account we cannot see, and a wrong guess
  // fails at request time with an error that says "model not found" instead of
  // "you have not chosen a model".
  return settings.models[settings.provider]?.trim() ?? ''
}
