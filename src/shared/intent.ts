/**
 * A deliberately small guess at what the user wants: an action or an explanation.
 *
 * The model still decides how to handle screen context. This guess does two
 * things: it gives explicit commands priority over background search, and it
 * lets the card hint that the assistant could have pressed the thing. Mouse
 * control ships switched off, so a user who says «запусти видео» gets a drawing
 * and would otherwise never learn that it could act. A pure keyword matcher is
 * enough for that, and cheap enough to run on every keystroke-free state change.
 *
 * The rules lean towards catching action verbs.
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
 * «Сделай» asks for the thing to be done, wherever it stands.
 *
 * It names no action of its own, so it is the word that most often carries a
 * conditional request: «можно ли …? если да — сделай». The opener is about
 * whether something is possible; the imperative is about the outcome, and
 * answering the first while ignoring the second is exactly the failure this
 * catches. Only the imperative matches: «можно ли так сделать» asks about the
 * possibility and asks for nothing.
 */
const EXPLICIT_REQUEST = /(^|[^а-яё])(сделай|сделайте)(?![а-яё])/i

/**
 * Questions. «Где кнопка экспорта», «что выбрать», «почему не работает» are
 * requests for an explanation, and answering them by clicking would be worse
 * than answering them with an arrow.
 */
const QUESTION =
  /(^|[^а-яё])(где|куда|откуда|когда|во сколько|что|чем|какой|какая|какое|какие|почему|зачем|сколько|подскажи|покажи|объясни|расскажи|переведи|перепиши|сократи)/i

/**
 * «Как» only counts as a question word in front position: mid-sentence it is
 * usually a simile («сделай как в прошлый раз»), which is still an action.
 */
const QUESTION_AT_START = /^(как|можно ли|а что|и что)/i

export function looksLikeAction(text: string): boolean {
  const value = text.trim()
  if (!value) return false
  if (ACTION_AT_START.test(value)) return true
  if (EXPLICIT_REQUEST.test(value)) return true
  if (QUESTION_AT_START.test(value)) return false
  if (QUESTION.test(value)) return false
  return ACTION.test(value)
}

/**
 * English imperatives, which the Russian stems above cannot see: «open the
 * pricing page», «… and then click Sign up».
 *
 * Only the start of the text or a clause after "and"/"then" counts, so a verb
 * merely mentioned inside an English sentence is not enough.
 */
const BROWSER_COMMAND =
  /(?:^|\b(?:and|then)\s+)(?:please\s+)?(?:open|launch|click|press|go to|navigate to)\b/i

/**
 * A Russian imperative that follows a question in the same sentence
 * («объясни, что тут, и нажми сохранить»).
 *
 * `looksLikeAction` has already answered "question" by the time this is
 * consulted — its question filter returns before the general action match — so
 * without this the trailing request would be treated as background search.
 */
const FOLLOWING_ACTION =
  /\s(?:и|затем|потом)\s+(?:открой|нажми|запусти|перейди|скачай|отправь)(?![а-яё])/i

/**
 * Whether a background web lookup is appropriate: true only when the prompt asks
 * for no action and no page to open, in either language.
 */
export function allowsWebLookup(prompt: string): boolean {
  const text = prompt.trim()
  return !looksLikeAction(text) && !BROWSER_COMMAND.test(text) && !FOLLOWING_ACTION.test(text)
}
