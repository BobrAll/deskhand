/**
 * Saving one provider's connection during onboarding.
 *
 * The wizard writes a key, a model id and an API root, and the store answers each
 * call with the whole bundle. Every save is built from that answer, so what one
 * provider's save writes is what the next provider's save spreads — never the
 * values the window loaded when it mounted.
 */

import type { SettingsBundle } from '@shared/api'
import type { AppSettings, ProviderId } from '@shared/types'

/** The two store calls onboarding needs; the real one is `window.deskhand.settings`. */
export interface ConnectionStore {
  setKey(provider: ProviderId, key: string): Promise<SettingsBundle>
  save(settings: AppSettings): Promise<SettingsBundle>
}

/** One provider as the wizard's form holds it: base URL already normalised. */
export interface ConnectionInput {
  provider: ProviderId
  key: string
  /** Empty means "use the provider's official host". */
  baseUrl: string
  /** Trimmed on the way in. */
  model: string
}

/** The settings with `input.provider` selected and its model and API root stored. */
function withConnection(settings: AppSettings, input: ConnectionInput): AppSettings {
  return {
    ...settings,
    provider: input.provider,
    models: { ...settings.models, [input.provider]: input.model.trim() },
    baseUrls: { ...settings.baseUrls, [input.provider]: input.baseUrl }
  }
}

/**
 * Stores one provider's key, model and API root.
 *
 * Each step builds on the bundle the store answered with, so the values written
 * for one provider are what the next provider's save spreads.
 */
export async function saveConnection(
  store: ConnectionStore,
  input: ConnectionInput
): Promise<SettingsBundle> {
  const keyed = await store.setKey(input.provider, input.key)
  return store.save(withConnection(keyed.settings, input))
}
