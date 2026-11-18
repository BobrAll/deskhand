/**
 * When the agent has to ask.
 *
 * The rule this file protects is a judgement, not a fact, so it is pinned down by
 * example: the actions the mode exists for must not produce a question (a user
 * who is asked about every scroll learns to press "разрешить" without reading),
 * and the ones that commit something must.
 */

import { describe, expect, it } from 'vitest'
import type { AgentToolRequest } from '@shared/types'
import { classifyCall, describeCall, rememberKey } from './approval'

const FP = 'a'.repeat(64)

function request(overrides: Partial<AgentToolRequest> = {}): AgentToolRequest {
  return { id: 'call-1', tool: 'click', arguments: {}, fingerprint: FP, app: 'Safari', ...overrides }
}

describe('classifyCall: the actions the mode exists for', () => {
  it.each(['scroll', 'drag', 'select_text', 'activate_app', 'perform_secondary_action'])(
    'lets %s through without asking',
    (tool) => {
      expect(classifyCall(request({ tool }), [])).toEqual({ kind: 'allow' })
    }
  )

  it('lets typing through: preparing text commits nothing', () => {
    expect(classifyCall(request({ tool: 'type_text', title: 'Поиск' }), [])).toEqual({ kind: 'allow' })
  })

  it('lets a click into a text field through', () => {
    expect(classifyCall(request({ tool: 'click', textField: true }), [])).toEqual({ kind: 'allow' })
  })

  it('lets an ordinary click through', () => {
    expect(classifyCall(request({ tool: 'click', title: 'Вкладка' }), [])).toEqual({ kind: 'allow' })
  })
})

describe('classifyCall: what commits something', () => {
  it.each([
    'Купить',
    'Оплатить',
    'Отправить',
    'Удалить',
    'Подписаться',
    'Поделиться',
    'Сменить пароль',
    'Place order',
    'Subscribe'
  ])('asks about «%s»', (title) => {
    expect(classifyCall(request({ title }), []).kind).toBe('confirm')
  })

  it('says what will happen, and what to check', () => {
    const decision = classifyCall(request({ title: 'Оплатить' }), [])

    expect(decision.kind).toBe('confirm')
    if (decision.kind !== 'confirm') return
    expect(decision.detail).toContain('Оплатить')
    expect(decision.detail).toContain('Safari')
    // The advice is about consequences, because that is the part the user cannot
    // see from the button's own label.
    expect(decision.detail).toContain('продавца')
  })

  it('reads the narration too, not just the title', () => {
    // A button called "Продолжить" that the model described as "оплатить заказ"
    // is an order, and the model's own words are the evidence available.
    const decision = classifyCall(request({ title: 'Продолжить', narration: 'Оплатить заказ' }), [])
    expect(decision.kind).toBe('confirm')
  })
})

describe('classifyCall: secrets', () => {
  it('refuses to type a password, without asking', () => {
    const decision = classifyCall(request({ tool: 'type_text', title: 'Пароль' }), [])

    // Two readers, two languages: the card lists the row in Russian, the model
    // reads the tool result in English.
    expect(decision).toEqual({
      kind: 'deny',
      label: 'Секреты и пароли введи вручную.',
      reason: 'Secrets and passwords must be typed by the user.'
    })
  })

  it('refuses an API key and a token as well', () => {
    expect(classifyCall(request({ tool: 'type_text', title: 'API key' }), []).kind).toBe('deny')
    expect(classifyCall(request({ tool: 'type_text', title: 'Токен доступа' }), []).kind).toBe('deny')
  })

  it('still allows ordinary text into a field called "Сообщение"', () => {
    expect(classifyCall(request({ tool: 'type_text', title: 'Сообщение' }), []).kind).toBe('allow')
  })
})

describe('classifyCall: keys', () => {
  it('asks about Enter in a message field: it sends', () => {
    const decision = classifyCall(request({ tool: 'press_key', arguments: { key: 'Return' }, title: 'Сообщение' }), [])
    expect(decision.kind).toBe('confirm')
  })

  it('lets a plain Enter in a search field through', () => {
    expect(classifyCall(request({ tool: 'press_key', arguments: { key: 'Return' }, title: 'Поиск' }), []).kind).toBe(
      'allow'
    )
  })

  it('asks about ⌘⌫ in Finder, which deletes', () => {
    expect(
      classifyCall(
        request({ tool: 'press_key', arguments: { key: 'super+BackSpace' }, bundleId: 'com.apple.finder' }),
        []
      ).kind
    ).toBe('confirm')
  })
})

describe('classifyCall: remembered approvals', () => {
  it('does not ask twice for the same fingerprint', () => {
    expect(classifyCall(request({ title: 'Оплатить' }), [rememberKey(FP)])).toEqual({ kind: 'allow' })
  })

  it('does not remember a secret away', () => {
    // The deny is checked first on purpose: "разрешить всегда" must never be able
    // to cover typing a password.
    expect(classifyCall(request({ tool: 'type_text', title: 'Пароль' }), [rememberKey(FP)]).kind).toBe('deny')
  })

  it('does not leak one remembered call into another', () => {
    expect(classifyCall(request({ title: 'Оплатить', fingerprint: 'b'.repeat(64) }), [rememberKey(FP)]).kind).toBe(
      'confirm'
    )
  })
})

describe('rememberKey', () => {
  it('gives a fixed-size, opaque digest the settings file can hold', () => {
    const key = rememberKey('click\u0001com.apple.Safari\u0001AXButton\u0001Купить')

    // The settings validator only accepts this shape; anything else is dropped
    // on the way in, and a dropped key means "разрешить всегда" silently forgets.
    expect(key).toMatch(/^[a-f0-9]{64}$/)
  })

  it('is stable across calls and distinct between actions', () => {
    expect(rememberKey(FP)).toBe(rememberKey(FP))
    expect(rememberKey(FP)).not.toBe(rememberKey('b'.repeat(64)))
  })
})

describe('describeCall', () => {
  it('names the element, never the typed text', () => {
    const line = describeCall(
      request({
        tool: 'type_text',
        title: 'Поиск',
        arguments: { text: 'очень личное' }
      })
    )

    expect(line).toBe('Печатаю в «Поиск»')
    expect(line).not.toContain('очень личное')
  })

  it.each([
    ['activate_app', { app: 'Telegram' }, 'Открываю «Telegram»'],
    ['click', { label: 'Экспорт' }, 'Нажимаю «Экспорт»'],
    ['press_key', { key: 'super+s' }, 'Нажимаю super+s'],
    ['scroll', {}, 'Прокручиваю в «Safari»']
  ])('describes %s for the card', (tool, args, expected) => {
    expect(describeCall(request({ tool, arguments: args, title: undefined }))).toBe(expected)
  })
})
