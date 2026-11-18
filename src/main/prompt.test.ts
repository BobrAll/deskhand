import { describe, expect, it } from 'vitest'

import type { ActiveAppInfo, ContextSnapshot, ResponseMode } from '@shared/types'
import { MAX_ANSWER_CHARS, MAX_SELECTION_CHARS, buildRefine, buildRequest } from './prompt'

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
  requestedScreenshot?: boolean
  imageAttached?: boolean
  draw?: boolean
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
    requestedScreenshot: true,
    imageAttached: true,
    draw: false,
    ...overrides
  })
}

const RU_QUICK_ACTION = 'Напиши ответ на последнее сообщение в контексте.'
const EN_PROMPT = 'Summarize this page in three bullets.'

describe('buildRequest: golden matrix', () => {
  // The provider is not part of the prompt — the model name lives in the request
  // headers, not in the text. "Язык" is the language of the user's own prompt.
  const modes: ResponseMode[] = ['analyze', 'insert']
  const images = [true, false]
  const prompts = [
    ['ru', RU_QUICK_ACTION],
    ['en', EN_PROMPT]
  ] as const

  for (const mode of modes) {
    for (const imageAttached of images) {
      for (const [language, prompt] of prompts) {
        const name = `${mode} · image=${imageAttached} · ${language}`

        it(name, () => {
          const built = request({ mode, imageAttached, prompt, draw: imageAttached })

          expect(built).toMatchSnapshot()
        })
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
      requestedScreenshot: false,
      imageAttached: false
    })

    expect(userText).toContain('Контекст из приложения не собран.')
  })

  it('wraps the selection in triple quotes', () => {
    const { userText } = request({ imageAttached: false })

    expect(userText).toContain('Выделенный текст:\n"""\nВыделенный текст\n"""')
  })

  it('marks a truncated selection', () => {
    const { userText } = request({
      snapshot: snapshot({ selection: { text: 'x', truncated: true } }),
      imageAttached: false
    })

    expect(userText).toContain('(выделение обрезано из-за размера)')
  })

  it('marks the cut even when the collector did not call the selection truncated', () => {
    // The collector cuts at 24 000 characters; the prompt cuts at 12 000. A
    // selection between the two is halved here with `truncated` still false, and
    // the model has to know it is reading half a selection.
    const { userText } = request({
      snapshot: snapshot({ selection: { text: 'я'.repeat(MAX_SELECTION_CHARS + 1), truncated: false } }),
      imageAttached: false
    })

    expect(userText).toContain('(выделение обрезано из-за размера)')
  })

  it('says nothing about a cut when the selection fits', () => {
    expect(request({ imageAttached: false }).userText).not.toContain('(выделение обрезано')
  })

  it('caps the selection at 12000 characters', () => {
    const { userText } = request({
      snapshot: snapshot({ selection: { text: 'я'.repeat(20_000), truncated: false } }),
      imageAttached: false
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
    expect(request({ imageAttached: false }).userText).toContain('Скриншот недоступен, опирайся только на текст.')
  })

  it('explains the coordinate system only when a tool needs it', () => {
    const withTools = request({ draw: true, imageAttached: true }).userText
    const withoutTools = request({ draw: false, imageAttached: true }).userText

    expect(withTools).toContain('(0,0) — его')
    expect(withTools).toContain('@point')
    expect(withoutTools).not.toContain('(0,0)')
  })

  it('names only the drawing marker: acting is not a marker any more', () => {
    const { userText } = request({ draw: true })

    expect(userText).toContain('Все координаты @point')
    expect(userText).not.toContain('@click')
  })

  it('puts the outline after the screenshot note', () => {
    const { userText } = request({ draw: true, outline: 'Кнопки: Экспорт (0.4, 0.3)' })

    const screenshotAt = userText.indexOf('Приложен скриншот')
    const outlineAt = userText.indexOf('Кнопки: Экспорт')

    expect(outlineAt).toBeGreaterThan(screenshotAt)
  })

  it('ignores the outline when there is no drawing to aim', () => {
    expect(request({ draw: false, outline: 'Кнопки: Экспорт' }).userText).not.toContain('Кнопки')
  })

  it('always ends with the trimmed user prompt', () => {
    expect(request({ prompt: '  вопрос  ' }).userText.endsWith('[Запрос]\nвопрос')).toBe(true)
  })
})

describe('buildRequest: mode instruction', () => {
  it('uses the overlay format for analyze', () => {
    expect(request({ mode: 'analyze', draw: false }).modeInstruction).toContain('краткий разбор для показа в оверлее')
  })

  it('names the markdown the card can actually render', () => {
    // The card draws tables, lists, code and links; anything else the model
    // invents arrives as literal asterisks. Saying which markers exist is what
    // turns "a — b · c · d" lines into a table.
    const note = request({ mode: 'analyze', draw: false }).modeInstruction

    expect(note).toContain('таблицы')
    expect(note).toContain('списки')
    expect(note).toContain('ссылки')
  })

  it('keeps the insert format about structure, not decoration', () => {
    const note = request({ mode: 'insert', draw: false }).modeInstruction

    expect(note).toContain('только готовый текст для вставки')
    expect(note).toContain('списки и таблицы')
    expect(note).toContain('жирный и курсив не нужны')
  })

  it('uses the insert format for insert', () => {
    expect(request({ mode: 'insert', draw: false }).modeInstruction).toContain('только готовый текст для вставки')
  })

  it('adds the drawing tool after the format', () => {
    const { modeInstruction } = request({ draw: true })

    expect(modeInstruction.indexOf('Формат ответа')).toBeLessThan(modeInstruction.indexOf('@point'))
  })

  it('appends the drawing tool after the answer format', () => {
    const { modeInstruction } = request({ draw: true })

    expect(modeInstruction.indexOf('Формат ответа')).toBeLessThan(modeInstruction.indexOf('@point'))
  })

  it('explains why acting is unavailable when the request looks like an action', () => {
    const { modeInstruction } = request({
      actReason: 'Управление выключено в настройках',
      prompt: 'нажми на Экспорт'
    })

    expect(modeInstruction).toContain('Управление мышью и клавиатурой недоступно')
    expect(modeInstruction).toContain('Управление выключено в настройках')
  })

  it('marks the request as an action only when it reads like one', () => {
    const asQuestion = request({
      actReason: 'Управление выключено в настройках',
      prompt: 'что здесь написано?'
    }).modeInstruction
    const asAction = request({
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

  it('keeps the documented 8000-character ceiling', () => {
    // The cap test above compares against the constant itself, so it stays green
    // when the number moves. Only a literal pins what the prompt promises.
    expect(MAX_ANSWER_CHARS).toBe(8_000)
  })

  it('says the answer was cut when it is longer than the ceiling', () => {
    const baseAnswer = 'я'.repeat(MAX_ANSWER_CHARS + 2_000)
    const { userText } = buildRefine({
      baseAnswer,
      originalPrompt: '',
      direction: 'shorter',
      mode: 'analyze'
    })

    // "Короче" replaces the whole answer, so a model that is not told about the
    // cut shortens a text whose ending it never saw.
    expect(userText).toContain('(ответ обрезан из-за размера')
    expect(userText).toContain(String(MAX_ANSWER_CHARS))
    expect(userText).toContain(String(baseAnswer.length))
  })

  it('adds no cut note to an answer that fits', () => {
    const { userText } = buildRefine({
      baseAnswer: 'короткий ответ',
      originalPrompt: '',
      direction: 'longer',
      mode: 'analyze'
    })

    expect(userText).not.toContain('(ответ обрезан')
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
