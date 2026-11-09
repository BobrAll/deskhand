import { describe, expect, it } from 'vitest'
import { automaticSpeech, requestedReading, speechText } from './speech'

describe('spoken replies', () => {
  it('removes code, tables, URLs and tool instructions', () => {
    expect(speechText('# Итог\n**Текст** [ссылка](https://example.com)\n```js\nalert(1)\n```\n@point 0.2 0.3\n| A | B |')).toBe('Итог Текст ссылка')
  })
  it('keeps generated text and media commands silent', () => {
    expect(automaticSpeech('Напиши ответ на сообщение', 'Привет!')).toBe('')
    expect(automaticSpeech('Включи музыку', 'Готово.')).toBe('')
    expect(automaticSpeech('Включи музыку', 'Не удалось открыть приложение.', true)).toBe('Не удалось открыть приложение.')
  })
  it('reads explicit requests fully and limits automatic replies to three sentences', () => {
    const answer = 'Раз. Два. Три. Четыре.'
    expect(automaticSpeech('Объясни', answer)).toBe('Раз. Два. Три.')
    expect(automaticSpeech('Прочитай вслух', answer)).toBe(answer)
    expect(requestedReading('озвучь ответ')).toBe(true)
  })
  it('does not speak a truncated sentence', () => {
    expect(automaticSpeech('Объясни', 'Слово '.repeat(100))).toBe('Ответ готов.')
  })
})
