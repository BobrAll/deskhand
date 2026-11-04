import { describe, expect, it } from 'vitest'

import type { ActiveAppInfo, ContextSnapshot, ResponseMode } from '@shared/types'
import {
  MAX_ANSWER_CHARS,
  MAX_SELECTION_CHARS,
  buildContinue,
  buildRefine,
  buildRequest,
  buildVerify
} from './prompt'

const activeApp: ActiveAppInfo = {
  bundleId: 'com.apple.Safari',
  name: 'Safari',
  pid: 4242,
  windowTitle: 'Документ — Safari',
  windowId: 77,
  bounds: { x: 0, y: 0, width: 1440, height: 900 }
}

function snapshot(overrides: Partial<ContextSnapshot> = {}): ContextSnapshot {
  return {
    activeApp,
    selection: { text: 'Выделенный текст', truncated: false },
    screenshot: {
      dataUrl: 'data:image/jpeg;base64,AAAA',
      width: 1440,
      height: 900,
      bytes: 1234,
      capturedAt: 1_700_000_000_000,
      area: { x: 0, y: 0, width: 1440, height: 900 },
      fullScreen: false
    },
    screenshotPending: false,
    excluded: false,
    warnings: [],
    collectedMs: 30,
    ...overrides
  }
}

interface RequestOverrides {
  prompt?: string
  mode?: ResponseMode
  snapshot?: ContextSnapshot | null
  includeSelection?: boolean
  includeScreenshot?: boolean
  hasImage?: boolean
  draw?: boolean
  act?: boolean
  actReason?: string | null
  hasHistory?: boolean
  outline?: string | null
}

function request(overrides: RequestOverrides = {}) {
  return buildRequest({
    prompt: 'Что здесь происходит?',
    mode: 'analyze',
    snapshot: snapshot(),
    includeSelection: true,
    includeScreenshot: true,
    hasImage: true,
    draw: false,
    act: false,
    ...overrides
  })
}

const RU_QUICK_ACTION = 'Напиши ответ на последнее сообщение в контексте.'
const EN_PROMPT = 'Summarize this page in three bullets.'

describe('buildRequest: golden matrix', () => {
  // The provider is not part of the prompt — the model name lives in the request
  // headers, not in the text. "Язык" is the language of the user's own prompt.
  const modes: ResponseMode[] = ['analyze', 'insert']
  const acts = [false, true]
  const images = [true, false]
  const prompts = [
    ['ru', RU_QUICK_ACTION],
    ['en', EN_PROMPT]
  ] as const

  for (const mode of modes) {
    for (const act of acts) {
      for (const hasImage of images) {
        for (const [language, prompt] of prompts) {
          const name = `${mode} · act=${act} · image=${hasImage} · ${language}`

          it(name, () => {
            const built = request({ mode, act, hasImage, prompt, draw: hasImage })

            expect(built).toMatchSnapshot()
          })
        }
      }
    }
  }
})

describe('buildRequest: context block', () => {
  it('names the active app and window', () => {
    const { userText } = request()

    expect(userText).toContain('Приложение: Safari')
    expect(userText).toContain('Окно: Документ — Safari')
  })

  it('omits the window line when the title is empty', () => {
    const { userText } = request({
      snapshot: snapshot({ activeApp: { ...activeApp, windowTitle: '' } })
    })

    expect(userText).toContain('Приложение: Safari')
    expect(userText).not.toContain('Окно:')
  })

  it('falls back to a note when nothing could be collected', () => {
    const { userText } = request({
      snapshot: null,
      includeSelection: false,
      includeScreenshot: false,
      hasImage: false
    })

    expect(userText).toContain('Контекст из приложения не собран.')
  })

  it('wraps the selection in triple quotes', () => {
    const { userText } = request({ hasImage: false })

    expect(userText).toContain('Выделенный текст:\n"""\nВыделенный текст\n"""')
  })

  it('marks a truncated selection', () => {
    const { userText } = request({
      snapshot: snapshot({ selection: { text: 'x', truncated: true } }),
      hasImage: false
    })

    expect(userText).toContain('(выделение обрезано из-за размера)')
  })

  it('caps the selection at 12000 characters', () => {
    const { userText } = request({
      snapshot: snapshot({ selection: { text: 'я'.repeat(20_000), truncated: false } }),
      hasImage: false
    })

    expect(userText).toContain('я'.repeat(MAX_SELECTION_CHARS))
    expect(userText).not.toContain('я'.repeat(MAX_SELECTION_CHARS + 1))
  })

  it('skips the selection when includeSelection is false', () => {
    expect(request({ includeSelection: false }).userText).not.toContain('Выделенный текст')
  })

  it('names the whole screen when the screenshot is full-screen', () => {
    const { userText } = request({
      snapshot: snapshot({
        screenshot: {
          dataUrl: 'data:image/jpeg;base64,AAAA',
          width: 1440,
          height: 900,
          bytes: 1234,
          capturedAt: 1_700_000_000_000,
          area: null,
          fullScreen: true
        }
      })
    })

    expect(userText).toContain('Приложен скриншот — весь экран.')
  })

  it('names the active window when the screenshot is windowed', () => {
    expect(request().userText).toContain('Приложен скриншот — активное окно.')
  })

  it('says the screenshot is missing when one was requested but is absent', () => {
    expect(request({ hasImage: false }).userText).toContain(
      'Скриншот недоступен, опирайся только на текст.'
    )
  })

  it('explains the coordinate system only when a tool needs it', () => {
    const withTools = request({ draw: true, hasImage: true }).userText
    const withoutTools = request({ draw: false, act: false, hasImage: true }).userText

    expect(withTools).toContain('(0,0) — его')
    expect(withTools).toContain('@point')
    expect(withoutTools).not.toContain('(0,0)')
  })

  it('lists both markers when drawing and acting are available', () => {
    const { userText } = request({ draw: true, act: true })

    expect(userText).toContain('@point и @click')
  })

  it('puts the outline after the screenshot note', () => {
    const { userText } = request({ act: true, outline: 'Кнопки: Экспорт (0.4, 0.3)' })

    const screenshotAt = userText.indexOf('Приложен скриншот')
    const outlineAt = userText.indexOf('Кнопки: Экспорт')

    expect(outlineAt).toBeGreaterThan(screenshotAt)
  })

  it('ignores the outline when acting is off', () => {
    expect(request({ act: false, outline: 'Кнопки: Экспорт' }).userText).not.toContain('Кнопки')
  })

  it('always ends with the trimmed user prompt', () => {
    expect(request({ prompt: '  вопрос  ' }).userText.endsWith('[Запрос]\nвопрос')).toBe(true)
  })
})

describe('buildRequest: mode instruction', () => {
  it('uses the overlay format for analyze', () => {
    expect(request({ mode: 'analyze', draw: false }).modeInstruction).toContain(
      'краткий разбор для показа в оверлее'
    )
  })

  it('uses the insert format for insert', () => {
    expect(request({ mode: 'insert', draw: false }).modeInstruction).toContain(
      'только готовый текст для вставки'
    )
  })

  it('adds the drawing tool after the format', () => {
    const { modeInstruction } = request({ draw: true })

    expect(modeInstruction.indexOf('Формат ответа')).toBeLessThan(
      modeInstruction.indexOf('@point')
    )
  })

  it('adds the agent tool before the drawing tool', () => {
    const { modeInstruction } = request({ draw: true, act: true })

    expect(modeInstruction.indexOf('@click')).toBeLessThan(modeInstruction.indexOf('@point'))
  })

  it('explains why acting is unavailable when the request looks like an action', () => {
    const { modeInstruction } = request({
      act: false,
      actReason: 'Управление выключено в настройках',
      prompt: 'нажми на Экспорт'
    })

    expect(modeInstruction).toContain('Управление мышью и клавиатурой недоступно')
    expect(modeInstruction).toContain('Управление выключено в настройках')
  })

  it('marks the request as an action only when it reads like one', () => {
    const asQuestion = request({
      act: false,
      actReason: 'Управление выключено в настройках',
      prompt: 'что здесь написано?'
    }).modeInstruction
    const asAction = request({
      act: false,
      actReason: 'Управление выключено в настройках',
      prompt: 'нажми на Экспорт'
    }).modeInstruction

    // The note itself is always there when acting is off; the extra paragraph
    // that names the request as an action is not.
    expect(asQuestion).toContain('Управление мышью и клавиатурой недоступно')
    expect(asQuestion).not.toContain('Эта просьба — действие')
    expect(asAction).toContain('Эта просьба — действие')
  })

  it('prepends the history note when the request is a follow-up', () => {
    const { modeInstruction } = request({ hasHistory: true, draw: false })

    expect(modeInstruction.startsWith('[Разговор]')).toBe(true)
  })

  it('leaves the history note out of a standalone request', () => {
    expect(request({ hasHistory: false }).modeInstruction).not.toContain('[Разговор]')
  })
})

describe('buildContinue', () => {
  it('lists what was performed', () => {
    const { userText } = buildContinue({
      performed: ['Клик по «Экспорт»', 'Пауза'],
      prompt: 'нажми экспорт',
      round: 1,
      canContinue: true,
      act: true
    })

    expect(userText).toContain('• Клик по «Экспорт»')
    expect(userText).toContain('• Пауза')
    expect(userText).toContain('[Исходная просьба]\nнажми экспорт')
  })

  it('says nothing was done when the list is empty', () => {
    const { userText } = buildContinue({
      performed: [],
      prompt: '',
      round: 0,
      canContinue: true,
      act: false
    })

    expect(userText).toContain('(ничего)')
    expect(userText).not.toContain('[Исходная просьба]')
  })

  it('asks to finish when the step budget is spent', () => {
    const { userText } = buildContinue({
      performed: ['Клик'],
      prompt: 'нажми',
      round: 3,
      canContinue: false,
      act: true
    })

    expect(userText).toContain('Продолжать уже нельзя')
  })

  it('keeps the agent tool only while another round is allowed', () => {
    const canContinue = buildContinue({
      performed: [],
      prompt: 'нажми',
      round: 1,
      canContinue: true,
      act: true
    })
    const finished = buildContinue({
      performed: [],
      prompt: 'нажми',
      round: 3,
      canContinue: false,
      act: true
    })

    expect(canContinue.modeInstruction).toContain('@click')
    expect(finished.modeInstruction).not.toContain('@click')
  })

  it('matches the golden snapshot', () => {
    expect(
      buildContinue({
        performed: ['Клик по «Экспорт»'],
        prompt: 'нажми экспорт',
        round: 2,
        canContinue: true,
        act: true
      })
    ).toMatchSnapshot()
  })
})

describe('buildVerify', () => {
  it('warns that the actions are not evidence', () => {
    const { userText } = buildVerify({
      performed: ['Клик по «Экспорт»'],
      prompt: 'нажми экспорт',
      canFix: true
    })

    expect(userText).toContain('Это список действий, а не результат')
  })

  it('offers @done and a retry when a fix is still possible', () => {
    const { userText, modeInstruction } = buildVerify({
      performed: ['Клик'],
      prompt: 'нажми',
      canFix: true
    })

    expect(userText).toContain('@done')
    expect(modeInstruction).toContain('@click')
  })

  it('forbids acting when this is the final look', () => {
    const { userText, modeInstruction } = buildVerify({
      performed: ['Клик'],
      prompt: 'нажми',
      canFix: false
    })

    expect(userText).toContain('@done')
    // The final look may report but not act: the retry branch is absent.
    expect(userText).not.toContain('строки действий, которые исправят')
    expect(modeInstruction).not.toContain('@click')
  })

  it('matches the golden snapshot', () => {
    expect(
      buildVerify({ performed: ['Клик по «Экспорт»'], prompt: 'нажми экспорт', canFix: true })
    ).toMatchSnapshot()
  })
})

describe('buildRefine', () => {
  it('sends the previous answer and the direction, not the context', () => {
    const { userText } = buildRefine({
      baseAnswer: 'Предыдущий ответ',
      originalPrompt: 'что здесь?',
      direction: 'shorter',
      mode: 'analyze'
    })

    expect(userText).toContain('Предыдущий ответ')
    expect(userText).toContain('[Исходный запрос]\nчто здесь?')
    expect(userText).not.toContain('Приложение:')
  })

  it('caps the previous answer at 8000 characters', () => {
    const { userText } = buildRefine({
      baseAnswer: 'я'.repeat(10_000),
      originalPrompt: '',
      direction: 'longer',
      mode: 'analyze'
    })

    expect(userText).toContain('я'.repeat(MAX_ANSWER_CHARS))
    expect(userText).not.toContain('я'.repeat(MAX_ANSWER_CHARS + 1))
  })

  it('never offers a tool', () => {
    const { modeInstruction } = buildRefine({
      baseAnswer: 'ответ',
      originalPrompt: '',
      direction: 'shorter',
      mode: 'insert'
    })

    expect(modeInstruction).not.toContain('@point')
    expect(modeInstruction).not.toContain('@click')
  })

  it('matches the golden snapshot for each direction', () => {
    for (const direction of ['shorter', 'longer'] as const) {
      expect(
        buildRefine({
          baseAnswer: 'Черновик ответа.',
          originalPrompt: 'напиши ответ',
          direction,
          mode: 'analyze'
        }),
        direction
      ).toMatchSnapshot()
    }
  })
})
