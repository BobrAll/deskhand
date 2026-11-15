/**
 * Key probe used by the "Проверить ключ" button in Settings.
 *
 * It hits the same API root the chat request would use, so a self-hosted or
 * proxied base URL can be verified before it is saved.
 */

import type { ModelListResult, ProviderId, TestKeyResult } from '@shared/types'
import { normalizeBaseUrl, providerInfo, resolveBaseUrl } from '@shared/defaults'
import { apiEndpoint } from './http'
import { describeProviderStatus } from './statusText'

/** The probe must not hold the settings pane open longer than a person will wait. */
const TIMEOUT_MS = 12_000
/** Enough of an unexpected body to identify it, never the whole response. */
const BODY_PREVIEW_CHARS = 160

function apiHeaders(provider: ProviderId, key: string): Record<string, string> {
  return provider === 'anthropic'
    ? { 'x-api-key': key, 'anthropic-version': '2023-06-01' }
    : { Authorization: `Bearer ${key}` }
}

/** The provider as the person reads it in a sentence. */
function providerLabel(provider: ProviderId): string {
  return providerInfo(provider)?.label ?? provider
}

function probeMessage(status: number, provider: ProviderId, body: string): string {
  return describeProviderStatus(status, {
    label: providerLabel(provider),
    detail: body.slice(0, BODY_PREVIEW_CHARS),
    probe: true
  }).message
}

/**
 * @param baseUrl Optional override (usually the unsaved value from the settings
 *   form). An empty string means "use the provider default".
 */
export async function testApiKey(provider: ProviderId, key: string, baseUrl?: string): Promise<TestKeyResult> {
  const apiKey = key.trim()
  if (!apiKey) return { ok: false, message: 'Введи ключ.' }

  const fallback = providerInfo(provider)?.defaultBaseUrl ?? ''
  const root = normalizeBaseUrl(baseUrl) || fallback
  if (!root) return { ok: false, message: 'Некорректный base URL: нужен адрес вида https://host/v1.' }

  try {
    const path = provider === 'openrouter' ? 'key' : 'models'
    // One deadline for the whole probe: headers and body alike. A gateway that
    // answers headers and then stalls must not leave the button spinning.
    const signal = AbortSignal.timeout(TIMEOUT_MS)
    const response = await fetch(apiEndpoint(root, path).href, {
      headers: apiHeaders(provider, apiKey),
      signal
    })

    if (response.ok) {
      return { ok: true, message: `Ключ ${providerLabel(provider)} работает.` }
    }
    // A body that cannot be read is not an error of its own; a read cut off by
    // the deadline is, because then the status was never reported.
    const body = await response.text().catch((error: unknown) => {
      if (signal.aborted) throw error
      return ''
    })
    return { ok: false, message: probeMessage(response.status, provider, body) }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (/abort/i.test(message)) return { ok: false, message: 'Превышено время ожидания ответа.' }
    return { ok: false, message: 'Нет соединения с интернетом или сервис недоступен.' }
  }
}

export async function listProviderModels(provider: ProviderId, key: string, baseUrl: string): Promise<ModelListResult> {
  if (!key.trim()) return { ok: false, message: 'Сохрани ключ API.' }
  if (baseUrl.trim() && !normalizeBaseUrl(baseUrl)) {
    return { ok: false, message: 'Проверь Base URL.' }
  }

  const endpoint = apiEndpoint(resolveBaseUrl(provider, baseUrl), 'models')
  const signal = AbortSignal.timeout(TIMEOUT_MS)
  const models = new Set<string>()
  const cursors = new Set<string>()

  try {
    while (true) {
      const response = await fetch(endpoint, {
        headers: apiHeaders(provider, key.trim()),
        redirect: 'error',
        signal
      })
      if (!response.ok) {
        return { ok: false, message: probeMessage(response.status, provider, '') }
      }

      const page = (await response.json()) as { data?: unknown; has_more?: unknown; last_id?: unknown } | null
      if (!Array.isArray(page?.data)) return { ok: false, message: 'Сервис вернул список в неизвестном формате.' }

      for (const entry of page.data) {
        if (typeof entry?.id === 'string' && entry.id.trim()) models.add(entry.id.trim())
      }

      if (page.has_more !== true) break
      const cursor = page.last_id
      if (typeof cursor !== 'string' || !cursor || cursors.has(cursor)) {
        return { ok: false, message: 'Сервис вернул неполный список моделей.' }
      }
      cursors.add(cursor)
      endpoint.searchParams.set('after_id', cursor)
    }

    return models.size
      ? { ok: true, models: [...models].sort((a, b) => a.localeCompare(b)) }
      : { ok: false, message: 'Сервис вернул пустой список моделей.' }
  } catch {
    return {
      ok: false,
      message: signal.aborted ? 'Сервис не ответил вовремя.' : 'Не удалось загрузить список моделей.'
    }
  }
}
