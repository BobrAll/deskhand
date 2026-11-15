import { describe, expect, it } from 'vitest'
import { disabledReasoning, isReasoningModel } from './reasoning'

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

describe('isReasoningModel', () => {
  it.each(['o1', 'o3', 'o3-mini', 'o4-mini', 'gpt-5', 'gpt-5.1', 'gpt-5-mini', 'openai/gpt-5-mini'])(
    'recognises %s',
    (model) => {
      expect(isReasoningModel(model)).toBe(true)
    }
  )

  it.each(['gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'gpt-50', 'claude-3-5-sonnet-latest', 'local-model'])(
    'leaves %s on the chat parameter set',
    (model) => {
      expect(isReasoningModel(model)).toBe(false)
    }
  )
})
