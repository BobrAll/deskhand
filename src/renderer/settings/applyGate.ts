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
 * (an empty prompt becomes the default one, a half-typed token count is clamped,
 * a quick action without a prompt is dropped). Writing those through would fight
 * the user's keyboard, so the write waits until the field is finished.
 */
export const HOLD_REASON = {
  baseUrl: 'Проверьте адрес API — изменения не применены.',
  maxTokens: `Максимум токенов: от ${MAX_TOKENS_MIN} до ${MAX_TOKENS_MAX}.`,
  prompt: 'Пустой системный промпт оставлен прежним.',
  quickAction: 'У быстрого действия не хватает названия или промпта.',
  hotkey: 'Горячая клавиша не задана.'
} as const

/** The providers whose base URL override is not an address, and so cannot be stored. */
export function invalidBaseUrlProviders(draft: AppSettings): ProviderId[] {
  return PROVIDERS.filter((provider) => {
    const value = draft.baseUrls[provider.id]
    // Empty is not invalid: it means "use the official host".
    return value.trim() !== '' && normalizeBaseUrl(value) === ''
  }).map((provider) => provider.id)
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
  // Out of range, not merely odd: a cleared number field reads as 0 while the
  // user is retyping it, and clamping that would rewrite the field under them.
  if (!tokensInRange(draft.maxTokens)) return HOLD_REASON.maxTokens
  if (!draft.systemPrompt.trim()) return HOLD_REASON.prompt
  if (!draft.hotkey.trim()) return HOLD_REASON.hotkey
  if (draft.quickActions.some((action) => !action.label.trim() || !action.prompt.trim())) {
    return HOLD_REASON.quickAction
  }
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
 * Two kinds of values cannot go through as they stand, and they are handled
 * differently on purpose:
 *
 * - a quick action row that was just added and is still empty is simply not a
 *   quick action yet; the store drops it anyway, so dropping it here lets the
 *   rest of the write proceed;
 * - a field that is mid-edit (a half-typed token count, an address that is not
 *   a URL yet) is *reverted to what is on disk* instead. Writing it would make
 *   the store replace it silently — 0 becomes the floor, junk becomes "" — and
 *   the window would then show a value that is not the one being used.
 */
export function writableSettings(
  value: AppSettings,
  bundle: { settings: AppSettings } | null,
  invalidBaseUrls: ProviderId[]
): AppSettings {
  const next: AppSettings = {
    ...value,
    quickActions: value.quickActions.filter(
      (action) => action.label.trim() && action.prompt.trim()
    )
  }
  if (!bundle) return next

  const onDisk = bundle.settings
  if (invalidBaseUrls.length > 0) next.baseUrls = onDisk.baseUrls
  if (!tokensInRange(next.maxTokens)) next.maxTokens = onDisk.maxTokens
  if (!next.systemPrompt.trim()) next.systemPrompt = onDisk.systemPrompt
  if (!next.hotkey.trim()) next.hotkey = onDisk.hotkey
  return next
}
