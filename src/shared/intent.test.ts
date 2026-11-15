import { describe, expect, it } from 'vitest'

import { looksLikeAction } from './intent'

describe('looksLikeAction: an action asked for at the start', () => {
  it('recognises an imperative verb in front position', () => {
    for (const text of [
      'нажми сохранить',
      'открой новую вкладку',
      'запусти видео',
      'включи звук',
      'выключи уведомления',
      'переключи на тёмную тему',
      'закрой окно',
      'сохрани файл',
      'удали это письмо',
      'отправь сообщение',
      'обнови страницу',
      'создай папку',
      'добавь в избранное'
    ]) {
      expect(looksLikeAction(text), text).toBe(true)
    }
  })

  it('accepts a polite prefix and «давай»', () => {
    expect(looksLikeAction('пожалуйста, открой настройки')).toBe(true)
    expect(looksLikeAction('давай закроем это')).toBe(true)
    expect(looksLikeAction('Пожалуйста открой')).toBe(true)
  })

  it('is case-insensitive', () => {
    expect(looksLikeAction('Нажми сохранить')).toBe(true)
    expect(looksLikeAction('ОТКРОЙ ВКЛАДКУ')).toBe(true)
  })

  it('lets an imperative at the start win over a question word later on', () => {
    expect(looksLikeAction('открой вкладку и скажи, где я')).toBe(true)
    expect(looksLikeAction('нажми экспорт и объясни, что вышло')).toBe(true)
  })
})

describe('looksLikeAction: an action asked for mid-sentence', () => {
  it('recognises an action stem anywhere in the text', () => {
    expect(looksLikeAction('теперь нажми Enter')).toBe(true)
    expect(looksLikeAction('и потом переключи вкладку')).toBe(true)
    expect(looksLikeAction('всё-таки закрой это')).toBe(true)
  })

  it('matches an inflected stem, not a whole word', () => {
    expect(looksLikeAction('нажимаю и не работает — нажмите за меня')).toBe(true)
    expect(looksLikeAction('мне нужно открыть файл')).toBe(true)
  })

  it('treats a Cyrillic letter as a word boundary, like `\\b` would for Latin', () => {
    // `[^а-яё]` is the stand-in for a word boundary; a Latin prefix is one.
    expect(looksLikeAction('ok нажми')).toBe(true)
  })

  it('lets an explicit «сделай» answer a question that came before it', () => {
    expect(looksLikeAction('можно ли сделать так, чтобы чеки попадали в отдельную папку? если да — сделай')).toBe(true)
    expect(looksLikeAction('а что, так можно? тогда сделайте')).toBe(true)
  })
})

describe('looksLikeAction: what is a question, not an action', () => {
  it('does not treat a question at the start as an action', () => {
    expect(looksLikeAction('как это работает')).toBe(false)
    expect(looksLikeAction('можно ли так сделать')).toBe(false)
    expect(looksLikeAction('а что дальше')).toBe(false)
    expect(looksLikeAction('и что теперь')).toBe(false)
  })

  it('does not treat a question word anywhere as an action', () => {
    for (const text of [
      'где кнопка экспорта',
      'что выбрать',
      'почему не работает',
      'зачем это нужно',
      'сколько стоит подписка',
      'подскажи, как быть',
      'покажи, что тут',
      'объясни этот код',
      'переведи фразу',
      'перепиши абзац',
      'сократи текст',
      'какой браузер лучше'
    ]) {
      expect(looksLikeAction(text), text).toBe(false)
    }
  })

  it('still counts «сделай как в прошлый раз» as an action: mid-sentence «как» is a simile', () => {
    expect(looksLikeAction('сделай как в прошлый раз')).toBe(true)
  })
})

describe('looksLikeAction: the empty case', () => {
  it('returns false for empty and whitespace-only text', () => {
    expect(looksLikeAction('')).toBe(false)
    expect(looksLikeAction('   ')).toBe(false)
    expect(looksLikeAction('\n\t')).toBe(false)
  })

  it('returns false for text with neither a verb nor a question word', () => {
    expect(looksLikeAction('привет')).toBe(false)
    expect(looksLikeAction('это просто текст')).toBe(false)
  })
})
