/** Local content only: waiting must never make another model request. */
import { SPEECH_BANK } from '@shared/speechBank'

export const WAIT_STATUS_MS = 1500
export const WAIT_TIP_MS = 8000
export const WAIT_LONG_MS = 25000

export const WAITING_TIPS = [
  'Выдели нужный фрагмент перед вопросом — так проще объяснить, что изменить.',
  'Можно попросить объяснить ответ проще или показать конкретный пример.',
  'Длинную задачу удобнее проверять по шагам: сначала план, затем выполнение.',
  'Укажи желаемый формат: список, короткий ответ или готовый текст.',
  'Для точной правки полезно сказать, что нужно сохранить: смысл, тон или длину.'
] as const

export const waitingPhrases: readonly string[] = SPEECH_BANK.acknowledge.map((line) => line.text)

/** Which of the waiting rows the card shows, from how long the request has run. */
export type WaitStage = 'quiet' | 'status' | 'tip' | 'long'

export function waitingStage(elapsed: number): WaitStage {
  if (elapsed >= WAIT_LONG_MS) return 'long'
  if (elapsed >= WAIT_TIP_MS) return 'tip'
  if (elapsed >= WAIT_STATUS_MS) return 'status'
  return 'quiet'
}
