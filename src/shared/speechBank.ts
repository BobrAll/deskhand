/**
 * Everything the assistant can say without knowing the answer.
 *
 * A line here is a *state*, not a result: it stays true whatever the model
 * ends up saying, which is what makes it safe to pre-record and play before the
 * answer exists. The same list is the source of two things that must never
 * drift apart — the text the app speaks and the file that was recorded for it.
 * `id` is the file name under `src/renderer/overlay/speech/`.
 *
 * Rules a new line has to pass:
 * - no app names, buttons, amounts, recipients or typed text;
 * - no promise about the outcome ("сделал", "получилось");
 * - one short sentence, spoken address is "ты", no slang.
 */
export type SpeechCue =
  | 'acknowledge'
  | 'longWait'
  | 'agentProgress'
  | 'approval'
  | 'approved'
  | 'denied'
  | 'remembered'
  | 'done'
  | 'answerReady'
  | 'textReady'
  | 'incomplete'
  | 'failed'
  | 'stopped'
  | 'timeout'
  | 'notHeard'
  | 'recordFailed'
  | 'transcribeFailed'
  | 'noMic'
  | 'recordTooLong'
  | 'agentBlocked'
  | 'secret'

export interface SpeechLine {
  /** File name without the extension; also the stable identity of the line. */
  id: string
  text: string
}

export const SPEECH_BANK: Record<SpeechCue, readonly SpeechLine[]> = {
  /** A1: the model is thinking. One per turn, rate-limited. */
  acknowledge: [
    { id: 'ack-1', text: 'Сейчас посмотрю.' },
    { id: 'ack-2', text: 'Так, разберёмся.' },
    { id: 'ack-3', text: 'Секунду, подумаю.' },
    { id: 'ack-4', text: 'Хорошо, смотрю.' },
    { id: 'ack-5', text: 'Одну секунду.' },
    { id: 'ack-6', text: 'Подожди секунду, посмотрю.' },
    { id: 'ack-7', text: 'Сейчас разберусь.' },
    { id: 'ack-8', text: 'Так, посмотрим.' }
  ],
  /** A2: past the long-wait threshold, and the card is out of sight. */
  longWait: [
    { id: 'wait-1', text: 'Всё ещё работаю. Если надоест ждать — нажми Escape.' },
    { id: 'wait-2', text: 'Пока работаю. Захочешь остановить — жми Escape.' },
    { id: 'wait-3', text: 'Это дольше обычного. Я продолжаю, но можешь остановить.' },
    { id: 'wait-4', text: 'Ещё работаю — это может занять минуту.' },
    { id: 'wait-5', text: 'Всё ещё думаю. Если нужно, нажми Escape.' }
  ],
  /** A3: the agent has been acting for a while; a heartbeat, not a step report. */
  agentProgress: [
    { id: 'step-1', text: 'Продолжаю.' },
    { id: 'step-2', text: 'Двигаюсь дальше.' },
    { id: 'step-3', text: 'Следующий шаг.' },
    { id: 'step-4', text: 'Так, иду дальше.' },
    { id: 'step-5', text: 'Работаю по шагам.' }
  ],
  /** B1: the run stopped on a question. Never names the action. */
  approval: [
    { id: 'ask-1', text: 'Тут нужно твоё подтверждение.' },
    { id: 'ask-2', text: 'Жду твоего решения.' },
    { id: 'ask-3', text: 'Остановился на одном шаге.' },
    { id: 'ask-4', text: 'Дальше без твоего разрешения не пойду.' },
    { id: 'ask-5', text: 'Нужно разрешение на действие.' }
  ],
  approved: [
    { id: 'yes-1', text: 'Спасибо, продолжаю.' },
    { id: 'yes-2', text: 'Хорошо, выполняю.' },
    { id: 'yes-3', text: 'Так, выполняю.' },
    { id: 'yes-4', text: 'Понял, делаю.' }
  ],
  denied: [
    { id: 'no-1', text: 'Хорошо, не трогаю.' },
    { id: 'no-2', text: 'Понял, отменил.' },
    { id: 'no-3', text: 'Оставил как есть.' },
    { id: 'no-4', text: 'Как скажешь — отменил.' }
  ],
  remembered: [
    { id: 'always-1', text: 'Запомнил — больше не спрошу об этом действии.' },
    { id: 'always-2', text: 'Запомнил это действие.' },
    { id: 'always-3', text: 'Хорошо, запомнил. Больше не спрошу.' }
  ],
  /** C1: an agent run that succeeded and left nothing to read. */
  done: [
    { id: 'done-1', text: 'Готово.' },
    { id: 'done-2', text: 'Сделал.' },
    { id: 'done-3', text: 'Всё готово.' },
    { id: 'done-4', text: 'Готово, можно проверять.' },
    { id: 'done-5', text: 'Всё сделал.' },
    { id: 'done-6', text: 'Сделано.' }
  ],
  /** C2: an answer that is only code, a table or markup. */
  answerReady: [
    { id: 'answer-1', text: 'Ответ готов.' },
    { id: 'answer-2', text: 'Готово, смотри.' },
    { id: 'answer-3', text: 'Вот ответ.' },
    { id: 'answer-4', text: 'Ответ готов, смотри.' }
  ],
  /** C3: text the user asked for and will read, not listen to. */
  textReady: [
    { id: 'text-1', text: 'Текст готов.' },
    { id: 'text-2', text: 'Готово, можно забирать.' },
    { id: 'text-3', text: 'Готово, проверь.' },
    { id: 'text-4', text: 'Текст готов — проверь.' },
    { id: 'text-5', text: 'Готово, можно читать.' }
  ],
  incomplete: [
    { id: 'incomplete-1', text: 'Задача осталась невыполненной.' },
    { id: 'incomplete-2', text: 'Не довёл до конца.' },
    { id: 'incomplete-3', text: 'Не получилось закончить.' },
    { id: 'incomplete-4', text: 'До конца не дошёл.' }
  ],
  failed: [
    { id: 'failed-1', text: 'Не получилось.' },
    { id: 'failed-2', text: 'Что-то пошло не так.' },
    { id: 'failed-3', text: 'Не смог выполнить запрос.' },
    { id: 'failed-4', text: 'Не вышло.' },
    { id: 'failed-5', text: 'Запрос не прошёл.' }
  ],
  stopped: [
    { id: 'stopped-1', text: 'Остановил.' },
    { id: 'stopped-2', text: 'Хорошо, остановился.' },
    { id: 'stopped-3', text: 'Остановлено.' },
    { id: 'stopped-4', text: 'Понял, остановился.' }
  ],
  timeout: [
    { id: 'timeout-1', text: 'Время вышло. Результат не подтверждён — проверь, что успело сделаться.' },
    { id: 'timeout-2', text: 'Не дождался ответа. Проверь результат на экране.' },
    { id: 'timeout-3', text: 'Слишком долго — я остановился. Проверь, что получилось.' }
  ],
  notHeard: [
    { id: 'heard-1', text: 'Ничего не расслышал — попробуй ещё раз.' },
    { id: 'heard-2', text: 'Не разобрал. Повтори, пожалуйста.' },
    { id: 'heard-3', text: 'Не расслышал. Скажи ещё раз.' },
    { id: 'heard-4', text: 'Не уловил. Повтори, пожалуйста.' }
  ],
  recordFailed: [
    { id: 'record-1', text: 'Запись не удалась. Попробуй ещё раз.' },
    { id: 'record-2', text: 'Запись не дошла до распознавания — попробуй ещё раз.' },
    { id: 'record-3', text: 'Не получилось записать. Попробуй ещё раз.' }
  ],
  transcribeFailed: [
    { id: 'stt-1', text: 'Распознавание не ответило — попробуй ещё раз.' },
    { id: 'stt-2', text: 'Не дождался распознавания. Попробуй ещё раз.' },
    { id: 'stt-3', text: 'Речь не распозналась — повтори, пожалуйста.' }
  ],
  noMic: [
    { id: 'mic-1', text: 'Нет доступа к микрофону — разреши его в настройках macOS.' },
    { id: 'mic-2', text: 'Микрофон недоступен — разреши доступ в настройках macOS.' },
    { id: 'mic-3', text: 'Не могу включить микрофон — проверь разрешение в настройках macOS.' }
  ],
  recordTooLong: [
    { id: 'long-1', text: 'Запись остановлена: слишком долго.' },
    { id: 'long-2', text: 'Слишком долгая запись — я остановил.' },
    { id: 'long-3', text: 'Запись вышла слишком длинной. Попробуй короче.' }
  ],
  agentBlocked: [
    { id: 'blocked-1', text: 'Не могу управлять приложением — не хватает разрешения.' },
    { id: 'blocked-2', text: 'Управление недоступно.' },
    { id: 'blocked-3', text: 'Не хватает разрешения.' },
    { id: 'blocked-4', text: 'Без разрешения не смогу нажать.' }
  ],
  secret: [
    { id: 'secret-1', text: 'Секреты и пароли введи вручную.' },
    { id: 'secret-2', text: 'Пароли и секреты введи вручную — так безопаснее.' },
    { id: 'secret-3', text: 'Это введи сам: пароли и секреты я не трогаю.' }
  ]
}

/** Every line, in a stable order, for a lookup by text. */
export function speechLines(): SpeechLine[] {
  return Object.values(SPEECH_BANK).flat()
}
