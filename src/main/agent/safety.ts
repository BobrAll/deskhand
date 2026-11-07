import { createHash } from 'node:crypto'
import { parseShortcut } from './keys'
import type { AgentPlanStep, AxElementInfo } from '@shared/types'

export type SafetyDecision =
  | { kind: 'allow' }
  | { kind: 'deny'; reason: string }
  | { kind: 'confirm'; detail: string }

// These are risk signals, not a complete understanding of the application's UI.
const CRITICAL = /оплат|купить|покупк|оформить заказ|подтвердить заказ|подписаться|продлить подписк|перевести деньги|денежн\S* перевод|оформить кредит|взять займ|криптовалют|отправить|опубликовать|удалить|очистить корзину|предоставить доступ|разрешить доступ|поделиться|сменить пароль|изменить пароль|отключить.*(?:2fa|защит|аутентификац)|подписать|принять условия|установить|\b(?:pay|purchase|buy|checkout|place order|subscribe|send|publish|delete|erase|empty trash|transfer money|wire transfer|take out a loan|share|grant access|allow access|change password|disable security|disable 2fa|sign contract|accept terms|install)\b/i
const MESSAGE_FIELD = /сообщени|письмо|комментари|\b(?:message|reply|comment|chat)\b/i

export function assessAction(step: AgentPlanStep, element: AxElementInfo | null, bundleId?: string): SafetyDecision {
  const action = step.action
  if (['move', 'scroll', 'wait', 'done', 'look'].includes(action.kind)) return { kind: 'allow' }
  const context = [step.label, 'label' in action ? action.label : '', element?.title, element?.description, element?.help]
    .filter(Boolean).join(' ').normalize('NFKC')
  if (action.kind === 'type' && (element?.subrole === 'AXSecureTextField' ||
      /api[- ]?key|api[- ]?ключ|парол|password|seed phrase|секретн\S* ключ/i.test(context))) {
    return { kind: 'deny', reason: 'Секреты и пароли введите вручную.' }
  }

  // Preparing text and focusing a field do not commit the operation.
  if (action.kind === 'type') return { kind: 'allow' }
  if (action.kind === 'click' && (element?.editable || element?.role === 'AXTextField' || element?.role === 'AXTextArea')) {
    return { kind: 'allow' }
  }
  let critical = CRITICAL.test(context)
  if (action.kind === 'key') {
    const key = parseShortcut(action.combo)
    const submit = key?.keyCode === 36
    const command = Boolean(key && (key.flags & 0x00100000))
    const deleteKey = key?.keyCode === 51 || key?.keyCode === 117
    // Enter in a message composer and Cmd+Enter may send immediately.
    // Finder deletion shortcuts affect files, unlike Backspace while editing text.
    critical = Boolean((submit || key?.keyCode === 49) && critical) ||
      Boolean(submit && (command || MESSAGE_FIELD.test(context))) ||
      Boolean(bundleId === 'com.apple.finder' && command && deleteKey)
  }
  if (!critical) return { kind: 'allow' }

  let operation: string
  switch (action.kind) {
    case 'click': operation = `Нажать: ${element?.title || element?.description || element?.help || action.label || step.label}`; break
    case 'key': operation = `Нажать клавиши: ${action.combo} (${element?.title || step.label})`; break
    case 'drag': operation = `Перетащить: ${step.label}`; break
    default: return { kind: 'deny', reason: 'Неизвестное действие запрещено.' }
  }
  return {
    kind: 'confirm',
    detail: `${operation}\n\nПроверьте последствия в открытом приложении. Для оплаты — продавца, итоговую сумму и подписку; для отправки — получателя и содержимое. «Разрешить всегда» запомнит это действие для указанного приложения.`
  }
}

/** A permission matches the actual app, input, and observed control when available. */
export function approvalKey(step: AgentPlanStep, element: AxElementInfo | null, bundleId?: string): string | null {
  if (!bundleId) return null
  const { action } = step
  const target = element && (element.title || element.description)
    ? [element.role, element.subrole, element.title, element.description]
    : null
  let input: unknown
  switch (action.kind) {
    case 'click': input = [action.kind, action.button, target ?? [action.at, action.label, step.label]]; break
    case 'key': input = [action.kind, parseShortcut(action.combo), target ?? step.label]; break
    case 'drag': input = [action.kind, action.from, action.to, step.label]; break
    default: return null
  }
  return createHash('sha256').update(JSON.stringify([bundleId, input])).digest('hex')
}
