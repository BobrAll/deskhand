import type { PermissionState, ProviderId } from '@shared/types'
import type { SettingsBundle } from '@shared/api'
import { providerInfo } from '@shared/defaults'

export interface FinishState {
  heading: string
  hint: string
}

/**
 * What the last screen may claim.
 *
 * The wizard is skippable, so "Готово" is only true when the key, the model and
 * the one permission the assistant cannot work without are all in place. The
 * provider is the wizard's current selection rather than the one in the store:
 * the user may have switched it without saving anything yet.
 */
export function finishState(
  bundle: SettingsBundle | null,
  permissions: PermissionState,
  provider: ProviderId
): FinishState {
  if (!bundle) {
    return { heading: 'Готово', hint: 'Проверь настройки, если что-то не работает.' }
  }
  const label = providerInfo(provider)?.label ?? provider
  const configured = bundle.keys.some((key) => key.provider === provider && key.configured)
  const model = (bundle.settings.models?.[provider] ?? '').trim()

  if (!configured) {
    return {
      heading: 'Осталось добавить ключ',
      hint: `Вернись на шаг «Подключение» и сохрани ключ для ${label}. Без ключа ассистент не ответит.`
    }
  }
  if (!model) {
    return {
      heading: 'Осталось выбрать модель',
      hint: `Ключ для ${label} сохранён. Открой шаг «Подключение» и выбери модель.`
    }
  }
  if (!permissions.accessibility) {
    return {
      heading: 'Разреши доступ и перезапусти',
      hint: 'Без «Универсального доступа» ассистент не прочитает выделение. Выдай разрешение и перезапусти Deskhand.'
    }
  }
  return { heading: 'Готово', hint: 'Разрешения выданы, ключ и модель на месте. Можно пробовать.' }
}
