/**
 * A deliberately small guess at what the user wants: an action or an explanation.
 *
 * This is **not** used to route anything. The model still decides what to do —
 * it is the only one that can read the request in context. The guess exists for
 * one interface question the app got wrong on its own: mouse control ships
 * switched off, so a user who says «запусти видео» gets a drawing and has no way
 * to learn that the assistant could have pressed it. A pure keyword matcher is
 * enough to know when that line is worth showing, and cheap enough to run on
 * every keystroke-free state change.
 *
 * False positives are harmless (an extra hint line), false negatives are the
 * status quo, so the rules lean towards catching action verbs.
 */

/**
 * Verbs that ask for something to be done. Russian is inflected, so these are
 * stems, not words: «нажм» covers нажми/нажать/нажму/нажмите.
 *
 * `[^а-яё]` stands in for a word boundary — `\b` is ASCII-only and would treat
 * every Cyrillic letter as a boundary.
 */
const ACTION =
  /(^|[^а-яё])(нажм|жми|откр|запуст|включ|выключ|переключ|закр|сохран|впиш|введ|набер|выбер|постав|перемест|перетащ|прокрут|обнов|удали|скача|отправ|подтверд|созда|добав|перейд|загруз)/i

/**
 * Opening an action with the verb is the least ambiguous form there is:
 * «нажми сохранить», «открой новую вкладку». Checked before the question filter
 * so that an imperative is not defeated by a question word later in the same
 * sentence («открой вкладку и скажи, где я»).
 */
const ACTION_AT_START =
  /^(пожалуйста[,\s]+|давай[,\s]+)?(нажм|жми|откр|запуст|включ|выключ|переключ|закр|сохран|впиш|введ|набер|выбер|постав|перемест|перетащ|прокрут|обнов|удали|скача|отправ|подтверд|созда|добав|перейд|загруз|сделай)/i

/**
 * Questions. «Где кнопка экспорта», «что выбрать», «почему не работает» are
 * requests for an explanation, and answering them by clicking would be worse
 * than answering them with an arrow.
 */
const QUESTION =
  /(^|[^а-яё])(где|куда|откуда|что|чем|какой|какая|какое|какие|почему|зачем|сколько|подскажи|покажи|объясни|расскажи|переведи|перепиши|сократи)/i

/**
 * «Как» only counts as a question word in front position: mid-sentence it is
 * usually a simile («сделай как в прошлый раз»), which is still an action.
 */
const QUESTION_AT_START = /^(как|можно ли|а что|и что)/i

export function looksLikeAction(text: string): boolean {
  const value = text.trim()
  if (!value) return false
  if (ACTION_AT_START.test(value)) return true
  if (QUESTION_AT_START.test(value)) return false
  if (QUESTION.test(value)) return false
  return ACTION.test(value)
}