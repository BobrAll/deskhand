import { describe, expect, it } from 'vitest'
import type { AgentAction } from '@shared/types'
import { assessAction } from './safety'

const check = (action: AgentAction) => assessAction({ action, label: 'Шаг' }, null)

describe('critical actions only', () => {
  it.each<AgentAction>([
    { kind: 'click', at: { x: 0, y: 0 }, button: 'left', label: 'Продолжить' },
    { kind: 'click', at: { x: 0, y: 0 }, button: 'left', label: 'Поиск' },
    { kind: 'type', text: 'Купить молоко, удалить черновик' },
    { kind: 'key', combo: 'enter' }, { kind: 'key', combo: 'cmd+t' },
    { kind: 'key', combo: 'cmd+w' }, { kind: 'key', combo: 'backspace' },
    { kind: 'drag', from: { x: 0, y: 0 }, to: { x: 1, y: 1 } }
  ])('allows ordinary $kind', action => expect(check(action).kind).toBe('allow'))

  it.each(['Оплатить', 'Купить', 'Оформить заказ', 'Подписаться', 'Отправить',
    'Опубликовать', 'Удалить', 'Предоставить доступ', 'Изменить пароль',
    'Send money', 'Pay now', 'Delete permanently', 'Place order', 'Disable 2FA'])('confirms %s from the actual control', title => {
    expect(assessAction({ action: { kind: 'click', at: { x: 0, y: 0 }, button: 'left' }, label: 'Далее' },
      { role: 'AXButton', title }).kind).toBe('confirm')
  })

  it('checks the plan when accessibility is unavailable', () => {
    expect(check({ kind: 'click', at: { x: 0, y: 0 }, button: 'left', label: 'Оплатить' }).kind).toBe('confirm')
  })

  it.each(['enter', 'space'])('confirms %s on a payment control', combo => {
    expect(assessAction({ action: { kind: 'key', combo }, label: 'Далее' },
      { role: 'AXButton', title: 'Оплатить' }).kind).toBe('confirm')
  })

  it('allows moving away from a critical control', () => {
    expect(assessAction({ action: { kind: 'key', combo: 'tab' }, label: 'Шаг' },
      { role: 'AXButton', title: 'Оплатить' }).kind).toBe('allow')
  })

  it('allows composing but confirms sending a message', () => {
    const field = { role: 'AXTextArea', title: 'Сообщение', editable: true }
    expect(assessAction({ action: { kind: 'type', text: 'Привет' }, label: 'Ввод' }, field).kind).toBe('allow')
    expect(assessAction({ action: { kind: 'key', combo: 'enter' }, label: 'Шаг' }, field).kind).toBe('confirm')
    expect(check({ kind: 'key', combo: 'cmd+return' }).kind).toBe('confirm')
  })

  it('allows filling a payment field without confirming each keystroke', () => {
    expect(assessAction({ action: { kind: 'click', at: { x: 0, y: 0 }, button: 'left' }, label: 'Оплата' },
      { role: 'AXTextField', title: 'Адрес для оплаты', editable: true }).kind).toBe('allow')
  })

  it('confirms deleting files in Finder, not deleting text in an editor', () => {
    const step = { action: { kind: 'key' as const, combo: 'cmd+backspace' }, label: 'Шаг' }
    expect(assessAction(step, null, 'com.apple.finder').kind).toBe('confirm')
    expect(assessAction(step, null, 'com.apple.TextEdit').kind).toBe('allow')
  })

  it('keeps secrets manual', () => {
    expect(assessAction({ action: { kind: 'type', text: 'secret' }, label: 'Ввод' },
      { role: 'AXTextField', subrole: 'AXSecureTextField' }).kind).toBe('deny')
  })
})
