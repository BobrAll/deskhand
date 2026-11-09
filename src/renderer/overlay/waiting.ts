/** Local content only: waiting must never make another model request. */
import { SPEECH_BANK } from '@shared/speechBank'

export const WAIT_STATUS_MS = 1500
export const WAIT_TIP_MS = 8000
export const WAIT_LONG_MS = 25000
export const WAIT_VOICE_COOLDOWN_MS = 45000

export const waitingTips = [
  'Выделите нужный фрагмент перед вопросом — так проще объяснить, что изменить.',
  'Можно попросить объяснить ответ проще или показать конкретный пример.',
  'Длинную задачу удобнее проверять по шагам: сначала план, затем выполнение.',
  'Укажите желаемый формат: список, короткий ответ или готовый текст.',
  'Для точной правки полезно сказать, что нужно сохранить: смысл, тон или длину.'
] as const

export const waitingPhrases: readonly string[] = SPEECH_BANK.acknowledge.map((line) => line.text)

export function waitingStage(elapsed: number): 'quiet' | 'status' | 'tip' | 'long' {
  if (elapsed >= WAIT_LONG_MS) return 'long'
  if (elapsed >= WAIT_TIP_MS) return 'tip'
  if (elapsed >= WAIT_STATUS_MS) return 'status'
  return 'quiet'
}
