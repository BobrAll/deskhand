/**
 * Provider registry: one entry point that turns provider settings into a
 * streaming LLM implementation.
 */

import { providerInfo } from '@shared/defaults'
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
  const configured = settings.models[settings.provider]?.trim()
  if (configured) return configured
  // An id outside the registry has no default to fall back to; the empty string
  // is what the caller treats as "no model configured".
  return providerInfo(settings.provider)?.defaultModel ?? ''
}
