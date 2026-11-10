/**
 * The overlay controller, driven through `send()` against a mocked host, a
 * mocked writer and a mocked agent.
 *
 * What it covers, in the order the tests are grouped:
 *
 * - routing: an action request goes to the agent, a question to the writer, and
 *   neither pays for the other's round;
 * - the background web lookup the model asks for;
 * - the agent turn on the card;
 * - voice: the transcript stays on screen while the turn is already running;
 * - what a reopened card remembers;
 * - the pointer glow, claimed before the work starts;
 * - and the rule underneath all of it — a turn must never end with its result in
 *   an invisible panel. That used to be about a streaming answer arriving while
 *   the card was hidden for a voice turn; now it also covers the agent, whose run
 *   happens with the card click-through and whose answer arrives in one piece at
 *   the very end.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'
import { DEFAULT_SETTINGS } from '@shared/defaults'
import type { AgentRunResult, AppSettings, SendRequest } from '@shared/types'
import { beginAgentTurn, endAgentTurn } from '../agent/cursor'
import { captureScreenshot } from '../context/screenshot'
import { getProvider } from '../llm'
import { searchWeb } from '../llm/webSearch'
import { buildTurnRequest } from './request'
import { applyHistorySettings } from './history'
import { delay } from '../util'
import { consumeTurnStream } from '../turnStream'
import type { OverlayHost } from './host'

const state = vi.hoisted(() => ({
  settings: {} as AppSettings,
  text: 'Ответ',
  apiKey: 'test-key',
  fail: false,
  stream: false,
  afterChunk: () => {},
  webLookup: false,
  agentReady: false,
  onAgentRun: () => {},
  agentResult: { answer: '', actions: [] } as AgentRunResult,
  agentCalls: [] as { prompt: string }[],
  /** Whether the built turn says an image is going out. */
  useImage: false,
  /** How the mocked provider answers: refuse the image, then succeed. */
  imageRefusedOnce: false,
  streams: 0,
  /** What the agent reports as a warning it worked around. */
  agentNotice: undefined as string | undefined
}))

vi.mock('electron', () => ({ app: {}, BrowserWindow: {}, systemPreferences: { isTrustedAccessibilityClient: () => true } }))
vi.mock('electron-store', () => ({ default: class { store = {} } }))
vi.mock('../settings/store', () => ({
  getSettings: () => state.settings,
  patchSettings: (patch: Partial<AppSettings>) => Object.assign(state.settings, patch)
}))
vi.mock('../settings/secrets', () => ({ getApiKey: () => state.apiKey }))
vi.mock('../native/helper', () => ({
  helperBinary: () => '/tmp/helper',
  helperFrontWindow: vi.fn(),
  helperFrontApplication: vi.fn(),
  helperActivate: vi.fn(),
  helperWindow: vi.fn(),
  watchForAbort: vi.fn(() => ({ stop: vi.fn() }))
}))
vi.mock('../paste', () => ({ copyText: vi.fn(), pasteAnswer: vi.fn() }))
vi.mock('../pointer', () => ({ hideAnnotations: vi.fn(), showAnnotations: vi.fn() }))
vi.mock('../context/screenshot', () => ({ captureScreenshot: vi.fn() }))
vi.mock('../agent/outline', () => ({ describeScreen: vi.fn() }))
vi.mock('../agent/cursor', () => ({ beginAgentTurn: vi.fn(), endAgentTurn: vi.fn(), updateAgentCursor: vi.fn() }))
// The ghost pointer is a separate display layer with its own window; the
// overlay's job is only to tell it when a run starts and ends.
vi.mock('../agent/presentation', () => ({
  presentAgentAction: vi.fn(),
  updateAgentPointer: vi.fn()
}))
vi.mock('../agent/sidecar', () => ({ agentBinary: () => '/tmp/deskhand-agent' }))
vi.mock('../agent', () => ({
  createAgentController: () => ({
    availability: () => ({ enabled: true, ready: state.agentReady, reason: state.agentReady ? null : 'нет доступа' }),
    run: async (input: { prompt: string }) => {
      state.agentCalls.push(input)
      state.onAgentRun()
      return state.agentResult
    },
    stop: vi.fn(),
    answer: vi.fn(),
    dispose: vi.fn(),
    last: () => ({ phase: 'idle', step: 0, total: 0, label: '', notice: state.agentNotice })
  })
}))
vi.mock('../context/collect', () => ({
  collectContext: async () => ({
    snapshot: { activeApp: null, selection: null, screenshot: null, warnings: [], excluded: false },
    flags: { includeSelection: false, includeScreenshot: false }
  })
}))
vi.mock('../llm', () => ({ resolveChatModel: () => 'gpt-4o', getProvider: vi.fn() }))
vi.mock('../llm/webSearch', () => ({ searchWeb: vi.fn() }))
vi.mock('../util', () => ({ delay: vi.fn().mockResolvedValue(undefined) }))
vi.mock('./request', () => ({
  buildTurnRequest: vi.fn(async () => ({
    messages: [], maxTokens: 1024, area: null, canDraw: false, useImage: state.useImage
  }))
}))
vi.mock('../turnStream', async () => {
  const { ProviderError } = await import('../llm/provider')
  return {
    consumeTurnStream: vi.fn(async (options: { onText: (text: string) => void }) => {
      state.streams += 1
      if (state.imageRefusedOnce && state.streams === 1) {
        throw new ProviderError('Модель не принимает изображения', true, 400, true)
      }
      if (state.fail) throw new Error('Request failed')
      if (state.stream) { options.onText(state.text); state.afterChunk() }
      return { text: state.text, webLookup: state.webLookup }
    })
  }
})

beforeEach(() => {
  state.settings = structuredClone(DEFAULT_SETTINGS)
  state.settings.captureScreenshotByDefault = false
  state.settings.rememberConversation = false
  state.text = 'Ответ'
  state.apiKey = 'test-key'
  state.fail = false
  state.stream = false
  state.afterChunk = () => {}
  state.webLookup = false
  state.agentReady = false
  state.onAgentRun = () => {}
  state.agentResult = { answer: '', actions: [] }
  state.agentCalls = []
  state.useImage = false
  state.imageRefusedOnce = false
  state.streams = 0
  state.agentNotice = undefined
  applyHistorySettings(false, [])
})

async function harness() {
  const { createOverlayController } = await import('./index')
  let visible = false
  const send = vi.fn()
  const win = {
    isVisible: () => visible, isDestroyed: () => false, setContentProtection: vi.fn(), webContents: { send }
  } as unknown as BrowserWindow
  const host: OverlayHost = {
    prewarm: vi.fn(), show: vi.fn(() => { visible = true }),
    showInactive: vi.fn(() => { visible = true }),
    hide: vi.fn(() => { visible = false }), window: () => win,
    resize: vi.fn(), setDrawing: vi.fn(), setVoice: vi.fn(), setPassthrough: vi.fn()
  }
  const controller = createOverlayController(host)
  await controller.open()
  vi.mocked(host.showInactive).mockClear()
  vi.mocked(host.show).mockClear()
  const request: SendRequest = {
    requestId: 'r1', prompt: 'Вопрос', mode: 'analyze', voice: true,
    includeSelection: false, includeScreenshot: false
  }
  return { controller, host, request, send, visible: () => visible }
}

describe('routing: the agent or the writer', () => {
  it('sends an action request to the agent when the mode is ready', async () => {
    state.agentReady = true
    state.agentResult = { answer: 'Экспорт сохранён без вложений.', actions: [{ tool: 'click', label: 'Нажал «Экспорт»', ok: true }] }
    const h = await harness()

    await h.controller.send({ ...h.request, voice: false, prompt: 'Нажми «Экспорт»' })

    expect(state.agentCalls).toHaveLength(1)
    // The writer was never called: an action must not pay for a text round whose
    // only job would be to guess what the agent is about to do anyway.
    expect(buildTurnRequest).not.toHaveBeenCalled()
    expect(h.send).toHaveBeenCalledWith('overlay:stream', expect.objectContaining({
      type: 'done', text: 'Экспорт сохранён без вложений.'
    }))
  })

  it('brings back the card for a successful action without a written report', async () => {
    state.agentReady = true
    state.agentResult = { answer: '[[ACTION_DONE]]', actions: [] }
    const h = await harness()

    await h.controller.send({ ...h.request, voice: false, prompt: 'Открой новую вкладку' })

    expect(h.send).toHaveBeenCalledWith('overlay:stream', expect.objectContaining({
      type: 'done', text: ''
    }))
    expect(h.host.showInactive).toHaveBeenCalled()
  })

  it('keeps a question on the writer even when the agent is ready', async () => {
    state.agentReady = true
    const h = await harness()

    await h.controller.send({ ...h.request, voice: false, prompt: 'Что это за кнопка?' })

    expect(state.agentCalls).toHaveLength(0)
    expect(buildTurnRequest).toHaveBeenCalledOnce()
  })

  it('answers an action request in the writer when the agent cannot run', async () => {
    state.agentReady = false
    const h = await harness()

    await h.controller.send({ ...h.request, voice: false, prompt: 'Нажми «Экспорт»' })

    expect(state.agentCalls).toHaveLength(0)
    // The reason travels in the prompt, which is what produces "я не могу нажать,
    // вот почему" instead of a silent arrow at the button.
    expect(buildTurnRequest).toHaveBeenLastCalledWith(expect.objectContaining({
      availability: expect.objectContaining({ ready: false, reason: 'нет доступа' })
    }))
    expect(h.send).toHaveBeenCalledWith('overlay:stream', expect.objectContaining({ type: 'done' }))
  })

  it('never routes a rewrite to the agent', async () => {
    state.agentReady = true
    const h = await harness()

    await h.controller.send({
      ...h.request, voice: false, prompt: 'Нажми', refine: { direction: 'shorter', baseAnswer: 'Длинный ответ.' }
    })

    expect(state.agentCalls).toHaveLength(0)
  })
})

describe('background web lookup', () => {
  beforeEach(() => {
    vi.mocked(buildTurnRequest).mockClear()
    vi.mocked(searchWeb).mockReset().mockResolvedValue('Ответ со ссылкой на источник.')
  })

  it.each(['Курс ЦБ на сегодня', 'Когда открывается выставка?', 'Поищи расписание рейсов'])(
    'routes the model’s web decision to the search tool for %s',
    async (prompt) => {
      const h = await harness()
      state.webLookup = true
      await h.controller.send({ ...h.request, prompt, includeScreenshot: true })

      expect(searchWeb).toHaveBeenCalledWith(prompt, state.settings, 'test-key', expect.any(AbortSignal))
      expect(h.send).toHaveBeenCalledWith('overlay:stream', expect.objectContaining({
        type: 'done', text: 'Ответ со ссылкой на источник.'
      }))
    }
  )

  it('keeps a web failure on the web path', async () => {
    const h = await harness()
    state.webLookup = true
    vi.mocked(searchWeb).mockRejectedValueOnce(new Error('Веб-поиск недоступен'))
    await h.controller.send({ ...h.request, prompt: 'Курс доллара' })

    expect(state.agentCalls).toHaveLength(0)
    expect(h.send).toHaveBeenCalledWith('overlay:stream', expect.objectContaining({
      type: 'error', message: 'Веб-поиск недоступен'
    }))
  })
})

describe('the agent turn on the card', () => {
  beforeEach(() => {
    state.agentReady = true
  })

  it('keeps the card visible while a spoken action is running', async () => {
    const h = await harness()
    state.onAgentRun = vi.fn(() => expect(h.visible()).toBe(true))
    state.agentResult = { answer: '[[ACTION_DONE]]', actions: [] }

    await h.controller.send({ ...h.request, prompt: 'Открой вкладку' })

    expect(state.onAgentRun).toHaveBeenCalledOnce()
    expect(h.host.hide).not.toHaveBeenCalled()
  })

  it('brings the card back when the agent finishes with an answer', async () => {
    const h = await harness()
    h.host.hide()
    state.agentResult = { answer: 'Вкладка открыта.', actions: [{ tool: 'click', label: 'Нажал', ok: true }] }

    await h.controller.send({ ...h.request, voice: false, prompt: 'Открой вкладку' })

    expect(h.visible()).toBe(true)
    expect(h.send).toHaveBeenCalledWith('overlay:stream', expect.objectContaining({
      type: 'done', text: 'Вкладка открыта.'
    }))
  })

  it('reports a blocked run as an answer instead of an empty card', async () => {
    const h = await harness()
    state.agentResult = { answer: '', actions: [], message: 'Агентный режим выключен.', blocked: true }

    await h.controller.send({ ...h.request, voice: false, prompt: 'Нажми «ОК»' })

    expect(h.send).toHaveBeenCalledWith('overlay:stream', expect.objectContaining({
      type: 'done', text: 'Агентный режим выключен.'
    }))
  })

  it('says something when the agent stopped without an answer', async () => {
    const h = await harness()
    state.agentResult = {
      answer: '', actions: [{ tool: 'click', label: 'Нажал', ok: true }], aborted: true, message: 'Остановлено.'
    }

    await h.controller.send({ ...h.request, voice: false, prompt: 'Нажми «ОК»' })

    expect(h.send).toHaveBeenCalledWith('overlay:stream', expect.objectContaining({
      type: 'done', text: 'Остановлено.'
    }))
  })
})

describe('a provider that refuses the screenshot', () => {
  it('asks again without the image and still answers', async () => {
    state.useImage = true
    state.imageRefusedOnce = true
    const h = await harness()

    await h.controller.send({ ...h.request, voice: false })

    // Two rounds: the refused one, then the same question without the picture.
    expect(state.streams).toBe(2)
    expect(h.send).toHaveBeenCalledWith('overlay:stream', expect.objectContaining({
      type: 'done', text: 'Ответ'
    }))
  })

  it('says why the answer has no drawing', async () => {
    state.useImage = true
    state.imageRefusedOnce = true
    const h = await harness()

    await h.controller.send({ ...h.request, voice: false })

    const stateEvent = h.send.mock.calls
      .filter(([channel]) => channel === 'overlay:state')
      .at(-1)?.[1] as { warnings: string[] } | undefined
    expect(stateEvent?.warnings.join(' ')).toContain('не принимает изображения')
  })

  it('does not retry a failure that is not about the image', async () => {
    state.useImage = true
    state.fail = true
    const h = await harness()

    await h.controller.send({ ...h.request, voice: false })

    expect(state.streams).toBe(1)
    expect(h.send).toHaveBeenCalledWith('overlay:stream', expect.objectContaining({ type: 'error' }))
  })

  it('carries the agent’s own warning when the agent hit the same refusal', async () => {
    state.agentReady = true
    state.agentNotice = 'Модель не принимает изображения — продолжаю без скриншотов.'
    const h = await harness()

    await h.controller.send({ ...h.request, voice: false, prompt: 'Нажми «Экспорт»' })

    const stateEvent = h.send.mock.calls
      .filter(([channel]) => channel === 'overlay:state')
      .at(-1)?.[1] as { warnings: string[] } | undefined
    expect(stateEvent?.warnings.join(' ')).toContain('продолжаю без скриншотов')
  })
})

describe('voice result visibility', () => {
  it('starts routing a spoken turn without waiting for a transcript preview', async () => {
    const h = await harness()
    vi.mocked(delay).mockClear()
    vi.mocked(getProvider).mockClear()

    await h.controller.send(h.request)

    // The two seconds used to be a pause before the model was called. The
    // transcript is still on screen while the turn runs, so the work starts now.
    expect(delay).not.toHaveBeenCalledWith(2_000)
    expect(getProvider).toHaveBeenCalledTimes(1)
    expect(h.visible()).toBe(true)
    expect(h.send).toHaveBeenCalledWith('overlay:stream', expect.objectContaining({ type: 'done' }))
  })

  it('keeps the transcript on screen while the turn is already running', async () => {
    const h = await harness()
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    vi.mocked(consumeTurnStream).mockImplementationOnce(async (options) => {
      await gate
      options.onText('Ответ')
      return { text: 'Ответ', webLookup: false }
    })

    vi.useFakeTimers()
    try {
      const sending = h.controller.send(h.request)
      await vi.advanceTimersByTimeAsync(0)
      // The model is already being called; the card is still showing the words.
      expect(h.host.hide).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(2_000)
      expect(h.host.hide).toHaveBeenCalledOnce()

      release()
      await sending
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not hide a card that already shows the answer', async () => {
    const h = await harness()
    vi.useFakeTimers()
    try {
      const sending = h.controller.send(h.request)
      await vi.advanceTimersByTimeAsync(1_000)
      await sending
      await vi.advanceTimersByTimeAsync(2_000)

      // The two-second timer is cleared when the turn ends, so it cannot hide
      // the answer that just arrived.
      expect(h.host.hide).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('reveals an actual text answer even if the window became hidden', async () => {
    const h = await harness()
    h.host.hide()
    await h.controller.send(h.request)
    expect(h.host.showInactive).toHaveBeenCalled()
    expect(h.visible()).toBe(true)
    expect(h.send).toHaveBeenCalledWith('overlay:stream', expect.objectContaining({ type: 'done', text: 'Ответ' }))
  })

  it('prepares a protected screenshot for a spoken turn', async () => {
    const h = await harness()
    const shot = {
      dataUrl: 'data:image/jpeg;base64,abc', width: 1440, height: 900, bytes: 3,
      capturedAt: Date.now(), area: { x: 0, y: 0, width: 1440, height: 900 }, fullScreen: true
    }
    vi.mocked(captureScreenshot).mockClear().mockResolvedValueOnce(shot)
    vi.mocked(getProvider).mockClear()
    const prepare = vi.fn<typeof buildTurnRequest>(async ({ ensureFreshScreenshot }) => {
      expect(await ensureFreshScreenshot()).toBe(shot)
      return {
        messages: [], maxTokens: 1024, area: shot.area, screenshot: shot, useImage: true,
        canDraw: true, abandoned: false
      }
    })
    vi.mocked(buildTurnRequest).mockImplementationOnce(prepare)

    await h.controller.send({ ...h.request, includeScreenshot: true })

    expect(captureScreenshot).toHaveBeenCalledOnce()
    expect(h.host.window()?.setContentProtection).toHaveBeenCalledWith(true)
    expect(prepare).toHaveBeenCalledTimes(1)
    expect(getProvider).toHaveBeenCalledTimes(1)
  })

  it('reveals the first streamed text before the request finishes', async () => {
    const h = await harness()
    state.stream = true
    const afterChunk = vi.fn(() => {
      expect(h.visible()).toBe(true)
      expect(h.send).not.toHaveBeenCalledWith('overlay:stream', expect.objectContaining({ type: 'done' }))
    })
    state.afterChunk = afterChunk
    await h.controller.send(h.request)
    expect(afterChunk).toHaveBeenCalledOnce()
  })

  it('reveals setup errors before a request can start', async () => {
    const h = await harness()
    h.host.hide()
    state.apiKey = ''
    await h.controller.send(h.request)
    expect(h.visible()).toBe(true)
    expect(h.send).toHaveBeenCalledWith('overlay:stream', expect.objectContaining({ type: 'error' }))
  })

  it.each(['', '  \n '])('shows an explanation when the result has no text (%j)', async (text) => {
    const h = await harness()
    state.text = text
    await h.controller.send(h.request)
    expect(h.visible()).toBe(true)
    expect(h.send).toHaveBeenCalledWith('overlay:stream', expect.objectContaining({
      type: 'done',
      text: expect.stringContaining('Не удалось выполнить запрос')
    }))
  })

  it('shows a failed request instead of leaving its error in an invisible panel', async () => {
    const h = await harness()
    h.host.hide()
    state.fail = true
    await h.controller.send(h.request)
    expect(h.visible()).toBe(true)
    expect(h.send).toHaveBeenCalledWith('overlay:stream', expect.objectContaining({ type: 'error', message: 'Request failed' }))
  })

  it('does not hide an empty result of a typed request', async () => {
    const h = await harness()
    state.text = ''
    await h.controller.send({ ...h.request, voice: false })
    expect(h.visible()).toBe(true)
    expect(h.host.hide).not.toHaveBeenCalled()
  })
})

describe('conversation across cards', () => {
  it('remembers the prior request after reopening', async () => {
    state.settings.rememberConversation = true
    const h = await harness()
    await h.controller.send(h.request)
    h.host.hide()
    const previousSession = h.controller.state()?.sessionId
    await h.controller.open()
    expect(h.controller.state()?.sessionId).not.toBe(previousSession)

    await h.controller.send({ ...h.request, requestId: 'r2', prompt: 'Повтори' })
    expect(buildTurnRequest).toHaveBeenLastCalledWith(expect.objectContaining({
      previousCommand: h.request.prompt,
      history: []
    }))

    await h.controller.send({ ...h.request, requestId: 'r3', prompt: 'Что дальше?' })
    expect(buildTurnRequest).toHaveBeenLastCalledWith(expect.objectContaining({
      previousCommand: undefined,
      history: [expect.objectContaining({
        question: 'Повтори',
        answer: state.text
      })]
    }))
  })
})

describe('feedback before request preparation', () => {
  it('claims the ring before a slow run and releases it on failure', async () => {
    state.agentReady = true
    const h = await harness()
    vi.mocked(beginAgentTurn).mockClear().mockReturnValueOnce(42)
    vi.mocked(endAgentTurn).mockClear()
    // The run fails before it can produce anything: the ring must still be
    // released, or the pointer glow would outlive the run that claimed it.
    state.agentResult = { answer: '', actions: [], message: 'Context unavailable' }
    await h.controller.send({ ...h.request, voice: false, prompt: 'Открой новую вкладку' })
    expect(beginAgentTurn).toHaveBeenCalledWith('Задача принята · готовлю действия…')
    expect(endAgentTurn).toHaveBeenCalledWith(42)
    expect(h.send).toHaveBeenCalledWith('overlay:stream', expect.objectContaining({
      type: 'done', text: 'Context unavailable'
    }))
  })
})
