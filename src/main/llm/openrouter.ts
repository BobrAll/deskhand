/**
 * OpenAI-compatible chat completions (used by OpenAI and OpenRouter).
 *
 * OpenRouter speaks the same dialect as OpenAI; only the base URL, the
 * attribution headers and the model naming differ.
 */

import { OpenAIProvider } from './openai'

export class OpenRouterProvider extends OpenAIProvider {
  constructor() {
    super({
      id: 'openrouter',
      label: 'OpenRouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      extraHeaders: {
        // Optional but recommended by OpenRouter for rate-limit attribution.
        'HTTP-Referer': 'https://github.com/BobrAll/deskhand',
        'X-Title': 'Deskhand'
      }
    })
  }
}