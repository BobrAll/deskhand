import { describe, expect, it } from 'vitest'
import { answerIsSpoken, automaticSpeech, requestedReading, speechText } from './speech'

describe('spoken replies', () => {
  it('removes code, tables, URLs and tool instructions', () => {
    expect(speechText('# Итог\n**Текст** [ссылка](https://example.com)\n```js\nalert(1)\n```\n@point 0.2 0.3\n| A | B |')).toBe('Итог. Текст ссылка')
  })
  it('drops the code block when the answer ends before its closing fence', () => {
    expect(speechText('Вот пример.\n```js\nconsole.log(1)')).toBe('Вот пример.')
  })
  it('separates list items so each gets its own pause', () => {
    expect(speechText('- Первый пункт\n- Второй пункт\n- Третий пункт'))
      .toBe('Первый пункт. Второй пункт. Третий пункт')
  })
  it('keeps ordered numbers and separates those items too', () => {
    expect(speechText('1. Первый шаг\n2. Второй шаг')).toBe('1. Первый шаг. 2. Второй шаг')
  })
  it('puts a boundary after a heading and between paragraphs', () => {
    expect(speechText('# Заголовок\nПервый абзац\n\nВторой абзац.'))
      .toBe('Заголовок. Первый абзац. Второй абзац.')
  })
  it('does not pause inside a hand-wrapped paragraph', () => {
    expect(speechText('Длинное предложение\nпродолжается здесь.'))
      .toBe('Длинное предложение продолжается здесь.')
  })
  it('does not double punctuation at a boundary', () => {
    expect(speechText('Готово!\n- Ещё?')).toBe('Готово! Ещё?')
  })
  it('does not add a full stop after a closing quote', () => {
    expect(speechText('Он сказал "да."\n\nВторой абзац.')).toBe('Он сказал "да." Второй абзац.')
  })
  it('drops horizontal rules instead of reading them out', () => {
    expect(speechText('Первый абзац.\n---\nВторой абзац.')).toBe('Первый абзац. Второй абзац.')
  })
  it('treats a quoted marker as the marker it wraps', () => {
    expect(speechText('> - Пункт\n> # Итог')).toBe('Пункт. Итог')
  })
  it('is idempotent, quoted markers included', () => {
    for (const text of ['> - Пункт\n> - Ещё', '> # Итог\n> Текст', '1. Первый шаг\n2. Второй']) {
      const once = speechText(text)
      expect(speechText(once)).toBe(once)
    }
  })
  it('still drops code blocks, tables and URLs', () => {
    const text = 'Первый абзац.\n```js\nconsole.log(1)\n```\nСсылка: https://example.com/page\n| A | B |\n| 1 | 2 |\nВторой абзац.'
    expect(speechText(text)).toBe('Первый абзац. Ссылка: Второй абзац.')
  })
  it('leaves Russian text with ordinary punctuation unchanged', () => {
    const text = 'Привет, мир! Как дела? Всё хорошо.'
    expect(speechText(text)).toBe(text)
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
  it('knows from the prompt alone whether the answer will be spoken', () => {
    // Used to decide whether pronouncing its English words ahead of time is
    // worth a request: a silent answer's words are never heard.
    expect(answerIsSpoken('Объясни, что такое Figma')).toBe(true)
    expect(answerIsSpoken('Напиши письмо про Figma')).toBe(false)
    expect(answerIsSpoken('Переведи этот текст')).toBe(false)
    expect(answerIsSpoken('Включи видео про Figma')).toBe(false)
    expect(answerIsSpoken('Напиши и прочитай вслух')).toBe(true)
  })
  it('keeps long answers and shortens long failures', () => {
    const answer = 'Слово '.repeat(100).trim()
    expect(automaticSpeech('Объясни', answer)).toBe(answer)
    expect(automaticSpeech('Объясни', answer, true)).toBe('Ответ готов.')
  })
})
