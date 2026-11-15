import { providerInfo } from '@shared/defaults'
import type { AgentAvailability, OverlayState } from '@shared/types'
import { resolveChatModel } from '../llm'
import { getApiKey } from '../settings/secrets'
import { getSettings } from '../settings/store'
import type { Session } from './session'

interface OverlayStateHost {
  current(): Session | null
  availability(): AgentAvailability
}

export function setupNotice(): OverlayState['setupNotice'] {
  const settings = getSettings()
  const label = providerInfo(settings.provider)?.label ?? settings.provider
  if (!resolveChatModel(settings)) {
    return {
      kind: 'warning',
      message: `Выбери модель ${label} в настройках.`,
      target: { tab: 'provider', view: 'models' }
    }
  }
  if (!getApiKey(settings.provider)) {
    return {
      kind: 'warning',
      message: `Добавь ключ ${label} в настройках, чтобы получать ответы.`,
      target: { tab: 'provider', view: 'connection' }
    }
  }
  return null
}

export function createOverlayState({ current, availability }: OverlayStateHost) {
  function overlayState(): OverlayState | null {
    const session = current()
    if (!session) return null
    const warnings = [...session.snapshot.warnings, ...session.notices]
    return {
      sessionId: session.id,
      context: session.snapshot,
      flags: session.flags,
      setupNotice: setupNotice(),
      warnings,
      agent: availability()
    }
  }

  return { overlayState }
}
