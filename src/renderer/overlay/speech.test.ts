import { describe, expect, it } from 'vitest'
import { automaticSpeech, requestedReading, speechText } from './speech'

describe('spoken replies', () => {
  it('removes code, tables, URLs and tool instructions', () => {
    expect(speechText('# Итог\n**Текст** [ссылка](https://example.com)\n```js\nalert(1)\n```\n@point 0.2 0.3\n| A | B |')).toBe('Итог Текст ссылка')
  })
  it('drops the code block when the answer ends before its closing fence', () => {
    expect(speechText('Вот пример.\n```js\nconsole.log(1)')).toBe('Вот пример.')
  })
  it('keeps generated text and media commands silent', () => {
    expect(automaticSpeech('Напиши ответ на сообщение', 'Привет!')).toBe('')
    expect(automaticSpeech('Включи музыку', 'Готово.')).toBe('')
    expect(automaticSpeech('Включи музыку', 'Не удалось открыть приложение.', true)).toBe('Не удалось открыть приложение.')
  })
  it('reads successful replies fully', () => {
    const answer = 'Раз. Два. Три. Четыре.'
    expect(automaticSpeech('Объясни', answer)).toBe(answer)
    expect(automaticSpeech('Прочитай вслух', answer)).toBe(answer)
    expect(requestedReading('озвучь ответ')).toBe(true)
  })
  it('keeps long answers and shortens long failures', () => {
    const answer = 'Слово '.repeat(100).trim()
    expect(automaticSpeech('Объясни', answer)).toBe(answer)
    expect(automaticSpeech('Объясни', answer, true)).toBe('Ответ готов.')
  })
})
