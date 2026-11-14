/**
 * When the agent has to ask before it acts.
 *
 * This is the one decision that stayed on the TypeScript side when the agent
 * itself moved to Swift. The reason is that it is not a fact about the machine,
 * it is a judgement about the user: which of the things an assistant can do are
 * the ones a person would want to be asked about. That belongs next to the
 * settings, the wording, and the "разрешить всегда" list.
 *
 * The agent asks before *every* mutating call and waits; this file answers most
 * of them with "да" without troubling the user. Typing into a field, scrolling,
 * pressing ⌘S — those are the actions the mode exists for. The ones that get a
 * question are the ones that commit something: money, sending, deleting, access.
 *
 * Deliberately a keyword classifier and not a model call. It runs inside the
 * agent's loop, once per click, and a second model round trip per click would
 * make the assistant slower than the human doing it by hand. It leans towards
 * asking: a needless question costs a second, a missing one costs a purchase.
 */

import { createHash } from 'node:crypto'
import type { AgentToolRequest } from '@shared/types'

export type ApprovalDecision =
  | { kind: 'allow' }
  /** Refused outright, without a question: the user's secrets are not the agent's to type. */
  | { kind: 'deny'; reason: string }
  /** Ask the user, and show them this. */
  | { kind: 'confirm'; detail: string }

/**
 * Risk signals, not a model of the interface.
 *
 * Inflected Russian, so these are stems, matched as substrings. Grouped by what
 * the action commits to, because that is the judgement this list encodes: money
 * leaves, something is said in public, something is destroyed, access is granted,
 * a credential changes, an agreement is signed. The groups are joined into one
 * expression, since the classifier only asks whether any of them is present.
 */
const PAYMENT_WORDS =
  'оплат|купить|покупк|оформить заказ|подтвердить заказ|подписаться|продлить подписк|' +
  'перевести деньги|денежн\\S* перевод|оформить кредит|взять займ|криптовалют'
const SENDING_WORDS = 'отправить|опубликовать'
const DELETION_WORDS = 'удалить|очистить корзину'
const ACCESS_WORDS = 'предоставить доступ|разрешить доступ|поделиться'
const PASSWORD_WORDS = 'сменить пароль|изменить пароль|отключить.*(?:2fa|защит|аутентификац)'
const AGREEMENT_WORDS = 'подписать|принять условия|установить'
/** English has real word boundaries, so the whole group is anchored to them. */
const ENGLISH_WORDS =
  '\\b(?:pay|purchase|buy|checkout|place order|subscribe|send|publish|delete|erase|' +
  'empty trash|transfer money|wire transfer|take out a loan|share|grant access|' +
  'allow access|change password|disable security|disable 2fa|sign contract|' +
  'accept terms|install)\\b'

const COMMITTING_ACTION = new RegExp(
  [
    PAYMENT_WORDS,
    SENDING_WORDS,
    DELETION_WORDS,
    ACCESS_WORDS,
    PASSWORD_WORDS,
    AGREEMENT_WORDS,
    ENGLISH_WORDS
  ].join('|'),
  'i'
)

const MESSAGE_FIELD = /сообщени|письмо|комментари|\b(?:message|reply|comment|chat)\b/i

const SECRET =
  /api[- ]?key|api[- ]?ключ|парол|password|seed phrase|секретн\S* ключ|passphrase|токен|token/i

/** Keys that submit something, in the xdotool grammar the agent uses. */
const SUBMIT_KEY = /(^|\+)(Return|KP_Enter|enter)$/i

/** The modifiers that make a keystroke a command rather than a character. */
const COMMAND_MODIFIER = /(^|\+)(ctrl|super|cmd)/i

/** The Finder key that sends a file to the Trash. */
const FINDER_DELETE_KEY = /(^|\+)(BackSpace|Delete)$/i

const FINDER_BUNDLE_ID = 'com.apple.finder'

/**
 * Tools that only read, or that prepare a change without committing it.
 *
 * `get_app_state` and `list_apps` never reach this file — the agent does not ask
 * about them at all. These are the ones it does ask about and the answer is
 * usually yes.
 */
const HARMLESS = new Set([
  'scroll',
  'drag',
  'select_text',
  'activate_app',
  'perform_secondary_action'
])

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** Everything the call is about, for the keyword match to look at. */
function matchableText(request: AgentToolRequest): string {
  const args = request.arguments
  return [
    request.title,
    request.label,
    text(args.label),
    text(args.name),
    text(args.action),
    request.narration
  ]
    .filter(Boolean)
    .join(' ')
    .normalize('NFKC')
}

/**
 * What the card should call this action.
 *
 * Written here rather than in the Swift agent because it is user-facing text in
 * the user's language, and the card is where the user's language lives.
 */
export function describeCall(request: AgentToolRequest): string {
  const args = request.arguments
  const app = request.app ? ` в «${request.app}»` : ''
  const named = request.title || request.label || text(args.label) || text(args.name)
  switch (request.tool) {
    case 'activate_app':
      return `Открываю «${text(args.app) || request.app || 'приложение'}»`
    case 'click':
      return named ? `Нажимаю «${named}»` : `Нажимаю${app}`
    case 'perform_secondary_action':
      return named ? `Меню действия «${named}»` : 'Открываю меню действия'
    case 'set_value':
      return named ? `Заполняю «${named}»` : 'Заполняю поле'
    case 'select_text':
      return named ? `Выделяю текст в «${named}»` : 'Выделяю текст'
    case 'type_text':
      // The text itself never reaches the card: it is the user's content, and a
      // log that quotes what was typed is a log that leaks it.
      return named ? `Печатаю в «${named}»` : 'Печатаю текст'
    case 'press_key':
      return `Нажимаю ${text(args.key) || 'клавиши'}`
    case 'scroll':
      return `Прокручиваю${app}`
    case 'drag':
      return named ? `Перетаскиваю «${named}»` : 'Перетаскиваю'
    case 'get_app_state':
      return 'Смотрю на экран'
    case 'list_apps':
      return 'Ищу приложение'
    default:
      return request.tool
  }
}

/**
 * The stored form of a fingerprint.
 *
 * The agent sends a readable fingerprint — tool, bundle, role, title — because
 * that is what makes it debuggable. The settings file stores a digest of it,
 * because a settings file is a place where the user can read what they allowed
 * and where a long line of UI strings is noise. Hashing on the way in also gives
 * a fixed-size value, so the list cannot grow a kilobyte per remembered action.
 */
export function rememberKey(fingerprint: string): string {
  return createHash('sha256').update(fingerprint).digest('hex')
}

/**
 * The imperative phrase the confirmation opens with.
 *
 * Pressing keys, clicking and dragging are named more directly than
 * `describeCall` does it: those three are the calls that land on something the
 * user cannot see in the question, so the question says what will be hit rather
 * than what the assistant is doing.
 */
function confirmationSubject(request: AgentToolRequest): string {
  if (request.tool === 'press_key') return `Нажать клавиши: ${text(request.arguments.key)}`
  if (request.tool === 'click') {
    return `Нажать: ${request.title || request.label || text(request.arguments.label) || 'элемент'}`
  }
  if (request.tool === 'drag') return 'Перетащить элемент'
  return describeCall(request)
}

/**
 * Whether a keystroke itself commits something.
 *
 * A key is judged by what it sends, not by what it is called: Return submits
 * only behind a command modifier, on a recognised message field, or on an
 * element the labels already call critical. ⌘⌫ deletes only in Finder, and a
 * plain character never commits at all, whatever the narration says.
 */
function keyCommits(context: string, request: AgentToolRequest): boolean {
  const key = text(request.arguments.key)
  const submit = SUBMIT_KEY.test(key)
  const command = COMMAND_MODIFIER.test(key)
  return (submit && COMMITTING_ACTION.test(context)) ||
    (submit && (command || MESSAGE_FIELD.test(context))) ||
    (request.bundleId === FINDER_BUNDLE_ID && command && FINDER_DELETE_KEY.test(key))
}

/**
 * Decides whether one call needs the user.
 *
 * `rememberedKeys` holds the digests of the fingerprints the user already allowed
 * forever; a call that matches one of them is not asked about again. The
 * fingerprint comes from the agent (app, role, title, button, key) and never
 * contains typed text, so a remembered approval covers the same button and not
 * the same sentence.
 */
export function classifyCall(request: AgentToolRequest, rememberedKeys: string[]): ApprovalDecision {
  const context = matchableText(request)

  // Never: a password typed by an assistant is a password in a transcript.
  if (request.tool === 'type_text' && SECRET.test(context)) {
    return { kind: 'deny', reason: 'Секреты и пароли введи вручную.' }
  }

  if (request.fingerprint && rememberedKeys.includes(rememberKey(request.fingerprint))) {
    return { kind: 'allow' }
  }
  if (HARMLESS.has(request.tool)) return { kind: 'allow' }

  // Preparing text and focusing a field commit nothing.
  if (request.tool === 'type_text' || request.tool === 'set_value') return { kind: 'allow' }
  if (request.tool === 'click' && request.textField) return { kind: 'allow' }

  const critical = request.tool === 'press_key'
    ? keyCommits(context, request)
    : COMMITTING_ACTION.test(context)
  if (!critical) return { kind: 'allow' }

  const subject = confirmationSubject(request)

  return {
    kind: 'confirm',
    detail: `${subject}${request.app ? ` — ${request.app}` : ''}\n\n` +
      'Проверь последствия в приложении: для оплаты — продавца, сумму и подписку; ' +
      'для отправки — получателя и содержимое. «Больше не спрашивать» запомнит это действие ' +
      'для этого приложения.'
  }
}
