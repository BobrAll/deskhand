import { describe, expect, it } from 'vitest'
import { disabledReasoning } from './reasoning'

describe('disabledReasoning', () => {
  it('disables generation rather than merely hiding OpenRouter reasoning', () => {
    expect(disabledReasoning('https://openrouter.ai/api/v1', 'any/model'))
      .toEqual({ reasoning: { enabled: false } })
  })
  it.each(['gpt-5.1', 'gpt-5.2', 'openai/gpt-6.1-sol'])('disables reasoning for %s', (model) => {
    expect(disabledReasoning('https://api.openai.com/v1', model))
      .toEqual({ reasoning_effort: 'none' })
  })
  it.each(['gpt-4o-mini', 'gpt-5', 'o3', 'local-model'])('avoids unsupported none for %s', (model) => {
    expect(disabledReasoning('https://api.openai.com/v1', model)).toEqual({})
  })
})
