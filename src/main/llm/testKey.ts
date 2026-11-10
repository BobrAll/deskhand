/**
 * Key probe used by the "Проверить ключ" button in Settings.
 *
 * It hits the same API root the chat request would use, so a self-hosted or
 * proxied base URL can be verified before it is saved.
 */

import type { ProviderId, TestKeyResult } from '@shared/types'
import { normalizeBaseUrl, providerInfo } from '@shared/defaults'

/** The probe must not hold the settings pane open longer than a person will wait. */
const TIMEOUT_MS = 12_000
/** Enough of an unexpected body to identify it, never the whole response. */
const BODY_PREVIEW_CHARS = 160

/** `fetch` with an abort timer, so a silent gateway still ends the probe. */
async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

function describe(status: number, body: string): string {
  if (status === 401 || status === 403) return 'Ключ не принят: проверь правильность ключа.'
  if (status === 402) return 'Ключ действителен, но на счёте нет средств.'
  if (status === 429) return 'Ключ действителен, но лимит запросов исчерпан.'
  if (status === 404) {
    return 'Сервис ответил 404: проверь base URL (нужен корень API, например …/v1).'
  }
  if (status >= 500) return 'Сервис провайдера недоступен, попробуй позже.'
  return `Неожиданный ответ ${status}: ${body.slice(0, BODY_PREVIEW_CHARS)}`
}

/**
 * @param baseUrl Optional override (usually the unsaved value from the settings
 *   form). An empty string means "use the provider default".
 */
export async function testApiKey(
  provider: ProviderId,
  key: string,
  baseUrl?: string
): Promise<TestKeyResult> {
  const apiKey = key.trim()
  if (!apiKey) return { ok: false, message: 'Введи ключ.' }

  const fallback = providerInfo(provider)?.defaultBaseUrl ?? ''
  const root = normalizeBaseUrl(baseUrl) || fallback
  if (!root) return { ok: false, message: 'Некорректный base URL: нужен адрес вида https://host/v1.' }

  try {
    let response: Response
    if (provider === 'anthropic') {
      response = await fetchWithTimeout(`${root}/models`, {
        method: 'GET',
        headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }
      })
    } else if (provider === 'openai') {
      response = await fetchWithTimeout(`${root}/models`, {
        headers: { Authorization: `Bearer ${apiKey}` }
      })
    } else {
      response = await fetchWithTimeout(`${root}/key`, {
        headers: { Authorization: `Bearer ${apiKey}` }
      })
    }

    if (response.ok) {
      const label = providerInfo(provider)?.label ?? provider
      return { ok: true, message: `Ключ ${label} работает.` }
    }

    const body = await response.text().catch(() => '')
    return { ok: false, message: describe(response.status, body) }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (/abort/i.test(message)) return { ok: false, message: 'Превышено время ожидания ответа.' }
    return { ok: false, message: 'Нет соединения с интернетом или сервис недоступен.' }
  }
}
