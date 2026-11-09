/**
 * When the settings window is allowed to write, and what it says while it is not.
 *
 * The window has no «Сохранить»: every field is written as it is edited. That is
 * what makes these rules load-bearing rather than cosmetic — a disagreement
 * between the copy that decides "hold the write" and the copy that decides "fix
 * the value up" does not throw, it produces a quiet write loop every 450 ms, or a
 * field rewritten under the user's hands while they are still typing in it.
 *
 * Everything here is pure. The bounds of the token field appear once, here, and
 * the JSX takes them from the constants — three copies of `64…8192` was exactly
 * the disagreement this module exists to prevent.
 */

import type { AppSettings, ProviderId } from '@shared/types'
import { PROVIDERS, normalizeBaseUrl } from '@shared/defaults'

/**
 * The token ceiling the field and the store both accept.
 *
 * Below the floor a reply is too short to be an answer; above the ceiling the
 * request is refused by the provider. Both ends are inclusive.
 */
export const MAX_TOKENS_MIN = 64
export const MAX_TOKENS_MAX = 8192

/**
 * Values the settings window cannot store as they are, and what it says instead.
 *
 * These are not "invalid input" warnings in the usual sense — they are the cases
 * where the normaliser on the other side would silently replace what is on screen
 * (an empty prompt becomes the default one, a half-typed token count is clamped).
 * The write waits until the user finishes editing the field.
 */
export const HOLD_REASON = {
  baseUrl: 'Проверьте адрес API — изменения не применены.',
  maxTokens: `Максимум токенов: от ${MAX_TOKENS_MIN} до ${MAX_TOKENS_MAX}.`,
  prompt: 'Пустой системный промпт оставлен прежним.',
  hotkey: 'Горячая клавиша не задана.',
  ttsBaseUrl: 'Проверьте адрес сервиса синтеза — изменения не применены.'
} as const

/** The providers whose base URL override is not an address, and so cannot be stored. */
export function invalidBaseUrlProviders(draft: AppSettings): ProviderId[] {
  return PROVIDERS.filter((provider) => {
    const value = draft.baseUrls[provider.id]
    // Empty is not invalid: it means "use the official host".
    return value.trim() !== '' && normalizeBaseUrl(value) === ''
  }).map((provider) => provider.id)
}

/**
 * Whether the synthesis endpoint is half-typed.
 *
 * Same rule as a provider URL: an empty field means "not configured", but text
 * that is not an address would be silently dropped by the store, and a field
 * that clears itself while it is being typed is worse than a held write.
 */
export function ttsBaseUrlInvalid(draft: AppSettings): boolean {
  // The block may be absent in a draft built before it existed, or in a test
  // fixture; "no block" means "not configured", not "invalid".
  const value = draft.tts?.baseUrl?.trim() ?? ''
  return value !== '' && normalizeBaseUrl(value) === ''
}

/** Whether a token count is one the store will keep as it is. */
export function tokensInRange(value: number): boolean {
  return Number.isFinite(value) && value >= MAX_TOKENS_MIN && value <= MAX_TOKENS_MAX
}

/**
 * Why a write is being held, or `null` when nothing is.
 *
 * The order matters only in that the first reason is the one shown: an address
 * that is not a URL is worth more attention than a token count mid-retype, and
 * both are worth more than a prompt that has been emptied on the way to being
 * rewritten.
 */
export function holdReasonFor(draft: AppSettings, invalidBaseUrls: ProviderId[]): string | null {
  if (invalidBaseUrls.length > 0) return HOLD_REASON.baseUrl
  if (ttsBaseUrlInvalid(draft)) return HOLD_REASON.ttsBaseUrl
  // Out of range, not merely odd: a cleared number field reads as 0 while the
  // user is retyping it, and clamping that would rewrite the field under them.
  if (!tokensInRange(draft.maxTokens)) return HOLD_REASON.maxTokens
  if (!draft.systemPrompt.trim()) return HOLD_REASON.prompt
  if (!draft.hotkey.trim()) return HOLD_REASON.hotkey
  return null
}

/** Whether the draft holds anything that is not on disk yet. */
export function hasUnsaved(
  value: AppSettings,
  bundle: { settings: AppSettings } | null,
  written: string | null
): boolean {
  if (!bundle) return true
  const snapshot = JSON.stringify(value)
  return snapshot !== JSON.stringify(bundle.settings) && snapshot !== written
}

/**
 * The draft as it can actually be written, for the explicit paths (⌘S, closing).
 *
 * Revert incomplete fields to their saved values so normalization does not
 * silently replace a half-typed value with a default.
 */
export function writableSettings(
  value: AppSettings,
  bundle: { settings: AppSettings } | null,
  invalidBaseUrls: ProviderId[]
): AppSettings {
  const next = { ...value }
  if (!bundle) return next

  const onDisk = bundle.settings
  if (invalidBaseUrls.length > 0) next.baseUrls = onDisk.baseUrls
  if (ttsBaseUrlInvalid(next)) next.tts = { ...next.tts, baseUrl: onDisk.tts?.baseUrl ?? '' }
  if (!tokensInRange(next.maxTokens)) next.maxTokens = onDisk.maxTokens
  if (!next.systemPrompt.trim()) next.systemPrompt = onDisk.systemPrompt
  if (!next.hotkey.trim()) next.hotkey = onDisk.hotkey
  return next
}
