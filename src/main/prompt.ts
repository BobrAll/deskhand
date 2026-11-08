/**
 * Assembles the prompt that is actually sent to the model.
 *
 * Kept in one place so that "what exactly leaves the machine" (ТЗ §5.4, §11) is
 * auditable, and so the overlay can show the same summary to the user.
 */

import type { ActiveAppInfo, ContextSnapshot, RefineDirection, ResponseMode } from '@shared/types'
import { looksLikeAction } from '@shared/intent'

export const MAX_SELECTION_CHARS = 12_000

/** The answer being rewritten is bounded so a runaway answer cannot blow the prompt. */
export const MAX_ANSWER_CHARS = 8_000

/** Ceiling for "длиннее": the answer is still meant to be read in the overlay. */
export const MAX_REFINE_TOKENS = 4096

export interface RequestInput {
  prompt: string
  mode: ResponseMode
  snapshot: ContextSnapshot | null
  includeSelection: boolean
  includeScreenshot: boolean
  hasImage: boolean
  /**
   * Whether the drawing tool is usable at all: there is an image to aim at and a
   * layer to paint on. It is *not* a user-facing mode — when it is true the model
   * decides for itself whether an answer needs a drawing.
   */
  draw: boolean
  /**
   * Why the assistant cannot act on this request, when it cannot.
   *
   * Acting is a different turn, not a tool of this one: a request that asks for
   * something to be *done* is handed to the agent, which sees the screen and
   * drives the machine itself. This note covers the one case where that route is
   * closed — the mode is off, or macOS has not granted Accessibility — because a
   * model offered only the drawing tool answers «нажми сохранить» with an arrow
   * at the Save button, and the user reads that as the assistant refusing to
   * help. It says what is missing instead.
   */
  actReason?: string | null
  /**
   * Whether the request is part of an ongoing conversation.
   *
   * The previous exchanges travel as real messages, but the model still has to be
   * told what they are for: a short question like «а почему?» is only a follow-up
   * because the turns before it exist, and a model that treats every request as
   * standalone answers it as if the topic were new.
   */
  hasHistory?: boolean
  /**
   * The named, clickable elements of the window the request is about, rendered
   * by `agent/outline.ts`.
   *
   * The model aims by eye at a downscaled screenshot; on a dense list that is
   * one row of error, and the row next door is a different setting. With the
   * exact names and their coordinates in front of it the model can copy a line
   * instead of measuring, and the click lands on the element it named.
   */
  outline?: string | null
}

export interface BuiltRequest {
  userText: string
  modeInstruction: string
}

export interface RefineInput {
  direction: RefineDirection
  /** The answer currently on screen — the model rewrites exactly this text. */
  baseAnswer: string
  mode: ResponseMode
  /** Original request, so the rework keeps the same intent. */
  originalPrompt: string
}

const REFINE_TASK: Record<RefineDirection, string> = {
  shorter:
    'Сократи этот ответ примерно вдвое: сохрани все ключевые мысли и структуру, убери повторы, ' +
    'примеры и второстепенные детали. Ничего нового не добавляй.',
  longer:
    'Разверни этот ответ: сохрани всё уже сказанное и добавь к каждому пункту детали, пояснения ' +
    'или короткий пример. Не убирай существующие мысли и не меняй их смысл.'
}

/**
 * The drawing tool.
 *
 * It is presented to the model as an optional instrument, not as a mode: the
 * assistant gets it with every request that carries a screenshot and decides on
 * its own whether the answer is better shown than written. Telling it *when not*
 * to draw matters as much as telling it how — a model that puts an arrow under
 * every reply turns a helpful gesture into noise.
 *
 * Why a line protocol and not JSON: the answer is streamed, and a stream cannot
 * be parsed as JSON until its last character. One complete line, however, can be
 * acted on immediately — so the arrow appears while the sentence explaining it is
 * still being written. See `annotations.ts` for the parser.
 */
const DRAW_TOOL = [
  '[Инструмент: рисовать на экране]',
  'Доступен в этом запросе. Пользователь его не включает: решай сам, нужен ли рисунок.',
  '',
  'Рисуй, когда человеку надо что-то найти, но сделать это придётся ему самому:',
  '«где кнопка», «куда это сохранилось», «почему не выходит», «что выбрать».',
  'Рисунок тут экономит абзац слов — он и есть ответ.',
  '',
  'Не рисуй, когда ответ — это текст: переписать, перевести, сократить, сочинить сообщение,',
  'объяснить смысл. Тем более не рисуй, если цель не видно на скриншоте: одно неверное',
  'обведение хуже, чем никакого.',
  '',
  'Если пользователь просит показать, где надпись, найти на экране, обвести или указать —',
  'для каждой уверенно найденной цели выдай @point: расположение словами не заменяет',
  'рисунок. Не пиши «обвёл», если нет @point.',
  'Для «обведи все иконки» осмотри весь скриншот и выдай отдельную фигуру для каждой',
  'различимой иконки, включая иконки без текста. Отсутствие названия в списке элементов',
  'не означает, что иконки нет: ищи её визуально на скриншоте.',
  'Если удалось найти только часть — обведи найденное и прямо скажи, что остальные',
  'не удалось уверенно распознать. Не утверждай, что найдены все, если это не проверено.',
  'Если цель не найдена или слишком мелкая — обязательно ответь текстом, что не удалось',
  'её найти или уверенно определить её границы. Не угадывай координаты и не молчи.',
  '',
  'Рисунок не заменяет действие. Если просят «нажми», «открой», «запусти», «переключи» —',
  'это просьба сделать, а не показать, и стрелка у кнопки, которую надо было нажать, — это',
  'невыполненная просьба. Выполнить её может отдельный агент; если он сейчас недоступен,',
  'скажи об этом прямо (ниже сказано, как) и только потом показывай, куда нажимать.',
  '',
  'Как рисовать. Отдельная строка на каждую фигуру:',
  '',
  '  @point arrow 0.10 0.10 0.60 0.42 «Экспорт»',
  '',
  'Формат строки: @point ВИД X1 Y1 X2 Y2 ПОДПИСЬ',
  '  ВИД — circle (обвести), box (рамка), arrow (стрелка), underline (подчеркнуть);',
  '  X Y — координаты от 0 до 1 в долях скриншота, начало отсчёта — левый верхний угол;',
  '  для circle и box это два противоположных угла, для arrow — хвост и остриё,',
  '  для underline — начало и конец линии;',
  '  ПОДПИСЬ — 1–4 слова в кавычках «…», необязательна.',
  '',
  'Как попасть в цель — это важнее всего остального:',
  '  • Центр фигуры ставь на середину элемента, а не рядом с ним.',
  '  • Стрелка начинается на пустом месте и остриём упирается в элемент.',
  '  • Фигура не должна занимать пол-экрана: сомневаешься — бери меньший размер.',
  '  • Не видно, где элемент — не добавляй @point и прямо скажи, что найти его не удалось.',
  '  • Строки @point не часть ответа: не упоминай их и сам формат в тексте.',
  '  • Если ответ можно вставить в поле, текст всё равно должен быть готовым к вставке,',
  '    а рисунок — дополнением к нему, а не заменой.'
].join('\n')

function contextLines(app: ActiveAppInfo | null): string[] {
  const lines: string[] = []
  if (app) {
    lines.push(`Приложение: ${app.name}`)
    if (app.windowTitle) lines.push(`Окно: ${app.windowTitle}`)
  }
  return lines
}

const OVERLAY_BASE = 'Формат ответа: краткий разбор для показа в оверлее. Markdown разрешён.'

const INSERT_BASE =
  'Формат ответа: только готовый текст для вставки в поле ввода. Без markdown-разметки, ' +
  'без кавычек вокруг всего ответа, без пояснений и вступлений.'

/**
 * The note that turns a request into a follow-up.
 *
 * The earlier turns are already in the message list, so this does not carry them
 * — it only tells the model what they are. The distinction it draws is the one
 * that was broken: «а почему?», «а подробнее», «а если иначе» are questions about
 * the *previous answer*, not new questions, and a model that reads them as
 * standalone either asks what is meant or invents a topic.
 *
 * It also says the opposite, because the over-correction is just as bad: a
 * follow-up that happens to mention a word from two turns ago must not drag the
 * whole old subject back in. Short history, short leash.
 */
const HISTORY_NOTE = [
  '[Разговор]',
  'Выше идут прошлые реплики или последняя просьба из предыдущей карточки.',
  'При «повтори» или «сделай ещё раз» используй этот контекст, чтобы понять, что повторить.',
  'Повторяй действия только по текущей просьбе и ориентируйся на текущий экран.',
  'Короткий вопрос («а почему?», «а подробнее», «а если наоборот») относится к',
  'предыдущему ответу: отвечай как продолжение, не переспрашивай и не начинай тему',
  'заново. Но и не притягивай за уши то, о чём уже не спрашивают: отвечай на то, что',
  'спросили сейчас.'
].join('\n')

export function withPreviousCommand(userText: string, previousCommand?: string): string {
  if (!previousCommand) return userText
  return `[Предыдущая просьба из другой карточки]\n${previousCommand}\n\n${userText}`
}

/**
 * What the model has to say when it can *see* the screen but must not touch it.
 *
 * This is the honest-answer case: the user asked for an action, and the app can
 * neither perform it nor pretend it did. It is a separate text from the drawing
 * tool because the failure it prevents is specific — a model offered only
 * "@point" answers a "нажми" request with an arrow, the user reads it as a
 * deflection, and the real reason (mode off, no Accessibility) never surfaces.
 */
const ACT_UNAVAILABLE = (reason: string, asked = false): string =>
  [
    '[Управление мышью и клавиатурой недоступно]',
    `Причина: ${reason}`,
    '',
    ...(asked
      ? [
          'Эта просьба — действие, а не вопрос: человек хочет, чтобы что-то нажали или',
          'запустили. Выполнить её нельзя, и рисунок вместо действия — это подделка ответа.',
          ''
        ]
      : []),
    'Если просят что-то сделать («нажми», «открой», «запусти», «переключи»), ты не можешь',
    'это выполнить. Не рисуй вместо этого стрелку у кнопки и не делай вид, что действие',
    'произошло: одной короткой фразой скажи, что не можешь нажать, назови причину из',
    'строки выше и подскажи, как включить управление (Настройки → Агент). После этого',
    'можно показать, куда нажимать, — но сначала скажи правду.'
  ].join('\n')

function formatInstruction(
  mode: ResponseMode,
  draw: boolean,
  actReason?: string | null,
  actAsked = false
): string {
  // The drawing tool does not replace the answer format, it is appended to it:
  // "вставить в поле" still has to produce a pasteable text, and a drawing is
  // something added to the sentence, not instead of it. The markers themselves
  // never reach the clipboard — the stream parser strips them before the text is
  // emitted.
  //
  // The unavailable-action note goes after the drawing tool on purpose: the model
  // reads the drawing instructions first, then the paragraph saying that an arrow
  // is not the action that was asked for. It still has to be able to draw — the
  // note cannot replace the tool, only qualify it.
  const base = mode === 'insert' ? INSERT_BASE : OVERLAY_BASE
  const tools = [
    draw ? DRAW_TOOL : '',
    actReason ? ACT_UNAVAILABLE(actReason, actAsked) : ''
  ]
    .filter(Boolean)
    .join('\n\n')
  return tools ? `${base}\n\n${tools}` : base
}

export function buildRequest(input: RequestInput): BuiltRequest {
  const lines: string[] = []
  const snapshot = input.snapshot

  if (snapshot) {
    lines.push(...contextLines(snapshot.activeApp))

    if (input.includeSelection && snapshot.selection) {
      const text = snapshot.selection.text.slice(0, MAX_SELECTION_CHARS)
      lines.push('Выделенный текст:')
      lines.push('"""')
      lines.push(text)
      lines.push('"""')
      if (snapshot.selection.truncated) lines.push('(выделение обрезано из-за размера)')
    }

    if (input.hasImage) {
      const what = snapshot?.screenshot?.fullScreen ? 'весь экран' : 'активное окно'
      lines.push(`Приложен скриншот — ${what}. Используй его как основной контекст.`)
      if (input.draw) {
        lines.push(
          'Все координаты @point считай по этому изображению: (0,0) — его ' +
            'левый верхний угол, (1,1) — правый нижний.'
        )
      }
    } else if (input.includeScreenshot) {
      lines.push('Скриншот недоступен, опирайся только на текст.')
    }

    // The exact names go after the screenshot note: the picture says what the
    // window looks like, this says what the things in it are called.
    if (input.draw && input.outline) {
      lines.push('')
      lines.push(input.outline)
    }
  }

  if (lines.length === 0) lines.push('Контекст из приложения не собран.')

  const userText = ['[Контекст]', ...lines, '', '[Запрос]', input.prompt.trim()].join('\n')

  const instruction = formatInstruction(
    input.mode,
    input.draw,
    input.actReason,
    // Only matters when acting is unavailable, and then it is the difference
    // between "I could not press it, here is why" and a drawing that pretends
    // the request was answered.
    Boolean(input.actReason) && looksLikeAction(input.prompt)
  )

  return {
    userText,
    modeInstruction: input.hasHistory ? `${HISTORY_NOTE}\n\n${instruction}` : instruction
  }
}

/**
 * "Короче / длиннее" on an answer that is already on screen.
 *
 * The context snapshot is deliberately not re-sent: the model only needs its own
 * previous answer plus the direction. That keeps the request small and makes the
 * result a rewrite of the same answer instead of a second, differently-grounded
 * one — which is exactly what "сделай саммари короче" should mean.
 */
export function buildRefine(input: RefineInput): BuiltRequest {
  const lines: string[] = ['[Предыдущий ответ]', '"""', input.baseAnswer.slice(0, MAX_ANSWER_CHARS), '"""']

  const original = input.originalPrompt.trim()
  if (original) lines.push('', '[Исходный запрос]', original)

  lines.push('', '[Задача]', REFINE_TASK[input.direction])
  lines.push('Верни только переработанный текст ответа, без пояснений о том, что изменилось.')

  return { userText: lines.join('\n'), modeInstruction: formatInstruction(input.mode, false) }
}
