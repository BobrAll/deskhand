/**
 * One table for both callers.
 *
 * The chat request and the "Проверить ключ" probe used to describe the same
 * status with different sentences, and the probe did not know about a context
 * that is too large. That is not a wording preference: a key could pass the
 * check and fail the request, and the person was told two different things
 * about the same 401.
 *
 * The one difference that is real is a parameter — a 404 from the probe means
 * the base URL is wrong, a 404 from a chat request means the model name is.
 */

import { describe, expect, it } from 'vitest'
import { describeProviderStatus } from './statusText'

describe('describeProviderStatus: the statuses both callers share', () => {
  it('names the provider and points at the key for 401 and 403', () => {
    for (const status of [401, 403]) {
      const text = describeProviderStatus(status, { label: 'OpenAI' })
      expect(text.message, String(status)).toBe('Ключ OpenAI не принят. Проверь ключ в настройках.')
      expect(text.retryable, String(status)).toBe(false)
    }
  })

  it('says the key is fine but the account is not', () => {
    expect(describeProviderStatus(402, { label: 'OpenAI' })).toEqual({
      message: 'Ключ OpenAI действителен, но на счёте нет средств.',
      retryable: false
    })
  })

  it('treats a rate limit as retryable, and still says the key was accepted', () => {
    const text = describeProviderStatus(429, { label: 'OpenAI' })
    expect(text.retryable).toBe(true)
    expect(text.message).toContain('лимит запросов исчерпан')
  })

  it('knows the context is too large', () => {
    expect(describeProviderStatus(413, { label: 'OpenAI' })).toEqual({
      message: 'Контекст слишком большой: уменьши скриншот или выделение.',
      retryable: false
    })
  })

  it('marks a provider outage retryable and keeps the status', () => {
    const text = describeProviderStatus(503, { label: 'Anthropic' })
    expect(text.message).toBe('Сервис Anthropic временно недоступен (503).')
    expect(text.retryable).toBe(true)
  })

  it('passes an unexpected status through with the provider detail', () => {
    const text = describeProviderStatus(418, { label: 'OpenAI', detail: 'teapot' })
    expect(text.message).toBe('Ошибка OpenAI (418): teapot')
    expect(text.retryable).toBe(true)
  })
})

describe('describeProviderStatus: the 404 means two different things', () => {
  it('points a chat request at the model name', () => {
    expect(describeProviderStatus(404, { label: 'OpenAI' }).message).toBe(
      'Модель не найдена у OpenAI. Проверь название модели.'
    )
  })

  it('points the key probe at the base URL', () => {
    expect(describeProviderStatus(404, { label: 'OpenAI', probe: true }).message).toContain('base URL')
  })
})
