import { describe, expect, it } from 'vitest'
import { emptyAnswerFallback } from './emptyAnswer'

describe('emptyAnswerFallback', () => {
  it.each(['', '  \n'])('explains an empty turn instead of silently finishing (%j)', (text) => {
    expect(emptyAnswerFallback(text, 0)).toContain('Не удалось выполнить запрос')
  })

  it('keeps a successful drawing-only response free of failure prose', () => {
    expect(emptyAnswerFallback('', 3)).toBe('')
  })

  it('preserves the explanation when the target was not found', () => {
    expect(emptyAnswerFallback('Не удалось найти pyweb на экране.', 0)).toBe('')
  })
})
