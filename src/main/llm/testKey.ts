/**
 * Key probe used by the "Проверить ключ" button in Settings.
 *
 * It hits the same API root the chat request would use, so a self-hosted or
 * proxied base URL can be verified before it is saved.
 */

import type { ModelListResult, ProviderId, TestKeyResult } from '@shared/types'
import { normalizeBaseUrl, providerInfo, resolveBaseUrl } from '@shared/defaults'
import { describeProviderStatus } from './statusText'

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

function apiHeaders(provider: ProviderId, key: string): Record<string, string> {
  return provider === 'anthropic'
    ? { 'x-api-key': key, 'anthropic-version': '2023-06-01' }
    : { Authorization: `Bearer ${key}` }
}

function describe(status: number, label: string, body: string): string {
  return describeProviderStatus(status, {
    label,
    detail: body.slice(0, BODY_PREVIEW_CHARS),
    probe: true
  }).message
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
    const path = provider === 'openrouter' ? 'key' : 'models'
    const response = await fetchWithTimeout(`${root}/${path}`, {
      headers: apiHeaders(provider, apiKey)
    })

    if (response.ok) {
      const label = providerInfo(provider)?.label ?? provider
      return { ok: true, message: `Ключ ${label} работает.` }
    }
    const body = await response.text().catch(() => '')
    const label = providerInfo(provider)?.label ?? provider
    return { ok: false, message: describe(response.status, label, body) }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (/abort/i.test(message)) return { ok: false, message: 'Превышено время ожидания ответа.' }
    return { ok: false, message: 'Нет соединения с интернетом или сервис недоступен.' }
  }
}

export async function listProviderModels(
  provider: ProviderId,
  key: string,
  baseUrl: string
): Promise<ModelListResult> {
  if (!key.trim()) return { ok: false, message: 'Сохрани ключ API.' }
  if (baseUrl.trim() && !normalizeBaseUrl(baseUrl)) {
    return { ok: false, message: 'Проверь Base URL.' }
  }

  const endpoint = new URL(resolveBaseUrl(provider, baseUrl))
  endpoint.pathname += '/models'
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
        return {
          ok: false,
          message: describe(response.status, providerInfo(provider)?.label ?? provider, '')
        }
      }

      const page = await response.json() as { data?: unknown; has_more?: unknown; last_id?: unknown } | null
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
