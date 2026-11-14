/**
 * Saving one provider's connection during onboarding.
 *
 * The wizard writes a key, a model id and an API root, and the store answers each
 * call with the whole bundle. Building the save from that answer rather than from
 * the bundle the window mounted with is what keeps the second provider from
 * writing the first one's model and root back: the mount-time copy still holds the
 * values from before onboarding started.
 */

import type { SettingsBundle } from '@shared/api'
import type { AppSettings, ProviderId } from '@shared/types'

/** The two store calls onboarding needs; the real one is `window.deskhand.settings`. */
export interface ConnectionStore {
  setKey(provider: ProviderId, key: string): Promise<SettingsBundle>
  save(settings: AppSettings): Promise<SettingsBundle>
}

export interface ConnectionInput {
  provider: ProviderId
  key: string
  /** Empty means "use the provider's official host". */
  baseUrl: string
  model: string
}

/** The settings after storing one provider's model and API root. */
export function withConnection(settings: AppSettings, input: ConnectionInput): AppSettings {
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
 * for one provider are what the next provider's save spreads — not the values
 * the window happened to load when it opened.
 */
export async function saveConnection(
  store: ConnectionStore,
  input: ConnectionInput
): Promise<SettingsBundle> {
  const keyed = await store.setKey(input.provider, input.key)
  return store.save(withConnection(keyed.settings, input))
}
