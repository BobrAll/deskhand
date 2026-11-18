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
import { CH } from '@shared/ipc'
import type { ActiveAppInfo, AgentRunResult, Annotation, AppSettings, ScreenshotInfo, SendRequest } from '@shared/types'
import { beginAgentTurn, endAgentTurn } from '../agent/cursor'
import { captureScreenshot } from '../context/screenshot'
import type { CaptureTarget } from '../context/screenshot'
import { getProvider } from '../llm'
import { searchWeb } from '../llm/webSearch'
import { helperActivate, helperFocused, helperFrontApplication, helperVisibleBundleIds } from '../native/helper'
import type { RawFrontApp } from '../native/helper'
import { buildTurnRequest } from './request'
import { applyHistorySettings } from './history'
import { delay } from '../util'
import { consumeTurnStream } from '../turnStream'
import type { OverlayHost } from './host'

const state = vi.hoisted(() => ({
  settings: {} as AppSettings,
  activeApp: null as ActiveAppInfo | null,
  text: 'Ответ',
  apiKey: 'test-key',
  fail: false,
  stream: false,
  afterChunk: () => {},
  webLookup: false,
  agentReady: false,
  onAgentRun: () => {},
  /** The mocked controller's `stop`, recorded so an abort can be checked. */
  agentStop: vi.fn<(message?: string) => void>(),
  /** Holds the mocked run in flight until the test releases it. */
  agentRunGate: null as Promise<void> | null,
  agentResult: { answer: '', actions: [] } as AgentRunResult,
  agentCalls: [] as { prompt: string }[],
  /** Whether the built turn says an image is going out. */
  useImage: false,
  /** How the mocked provider answers: refuse the image, then succeed. */
  imageRefusedOnce: false,
  streams: 0,
  /** What the agent reports as a warning it worked around. */
  agentNotice: undefined as string | undefined,
  /** Shapes the mocked writer paints during a turn. */
  annotations: [] as Annotation[],
  /** Holds context collection so a test can inspect an open that is in flight. */
  collectGate: null as Promise<void> | null,
  /** One gate per `collectContext` call, for tests that run two opens at once. */
  collectGates: [] as Promise<void>[],
  /** `app.hide()` from the mocked Electron module. */
  hideApp: vi.fn(),
  /** Windows the mocked `BrowserWindow.getAllWindows()` returns. */
  allWindows: [] as BrowserWindow[]
}))

vi.mock('electron', () => ({
  app: { hide: state.hideApp },
  BrowserWindow: { getAllWindows: () => state.allWindows },
  systemPreferences: { isTrustedAccessibilityClient: () => true }
}))
vi.mock('electron-store', () => ({
  default: class {
    store = {}
  }
}))
vi.mock('../settings/store', () => ({
  getSettings: () => state.settings,
  patchSettings: (patch: Partial<AppSettings>) => Object.assign(state.settings, patch)
}))
vi.mock('../settings/secrets', () => ({
  getApiKey: () => state.apiKey,
  hasApiKey: () => Boolean(state.apiKey)
}))
vi.mock('../native/helper', () => ({
  helperBinary: () => '/tmp/helper',
  helperFrontWindow: vi.fn(),
  helperFrontApplication: vi.fn(),
  helperFocused: vi.fn(),
  helperActivate: vi.fn(),
  helperVisibleBundleIds: vi.fn(async () => null),
  helperWindow: vi.fn(),
  watchForAbort: vi.fn(() => ({ stop: vi.fn() }))
}))
vi.mock('../paste', () => ({ copyText: vi.fn() }))
vi.mock('../drawing', () => ({ hideAnnotations: vi.fn(), showAnnotations: vi.fn() }))
vi.mock('../context/screenshot', () => ({ captureScreenshot: vi.fn() }))
vi.mock('../agent/outline', () => ({ describeScreen: vi.fn() }))
// Only the three functions that paint or own the display layer are replaced:
// everything else in the module stays real, so a new export cannot silently
// disappear from the controller's view of it.
vi.mock('../agent/cursor', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../agent/cursor')>()),
  beginAgentTurn: vi.fn(),
  endAgentTurn: vi.fn(),
  updateAgentCursor: vi.fn()
}))
// The ghost pointer is a separate display layer with its own window; the
// overlay's job is only to tell it when a run starts and ends.
vi.mock('../agent/presentation', () => ({
  paintAgentPresentation: vi.fn(),
  updateAgentPresentation: vi.fn()
}))
vi.mock('../agent/sidecar', () => ({ agentBinary: () => '/tmp/deskhand-agent' }))
vi.mock('../agent', () => ({
  createAgentController: () => ({
    availability: () => ({ enabled: true, ready: state.agentReady, reason: state.agentReady ? null : 'нет доступа' }),
    run: async (input: { prompt: string }) => {
      state.agentCalls.push(input)
      state.onAgentRun()
      if (state.agentRunGate) await state.agentRunGate
      return state.agentResult
    },
    stop: (message?: string) => state.agentStop(message),
    answer: vi.fn(),
    dispose: vi.fn(),
    last: () => ({ phase: 'idle', step: 0, total: 0, label: '', notice: state.agentNotice })
  })
}))
vi.mock('../context/collect', () => ({
  collectContext: async () => {
    const queued = state.collectGates.shift()
    if (queued) await queued
    if (state.collectGate) await state.collectGate
    return {
      snapshot: {
        activeApp: state.activeApp,
        selection: null,
        screenshot: null,
        warnings: [],
        excluded: false
      },
      flags: { includeSelection: false, includeScreenshot: false }
    }
  }
}))
vi.mock('../llm', () => ({ resolveChatModel: () => 'gpt-4o', getProvider: vi.fn() }))
vi.mock('../llm/webSearch', () => ({ searchWeb: vi.fn() }))
vi.mock('../util', () => ({ delay: vi.fn().mockResolvedValue(undefined) }))
vi.mock('./request', () => ({
  buildTurnRequest: vi.fn(async () => ({
    messages: [],
    maxTokens: 1024,
    area: null,
    canDraw: false,
    useImage: state.useImage
  }))
}))
vi.mock('../turnStream', async () => {
  const { ProviderError } = await import('../llm/provider')
  return {
    consumeTurnStream: vi.fn(
      async (options: { onText: (text: string) => void; onAnnotations?: (annotations: Annotation[]) => void }) => {
        state.streams += 1
        if (state.imageRefusedOnce && state.streams === 1) {
          throw new ProviderError('Модель не принимает изображения', true, 400, true)
        }
        if (state.fail) throw new Error('Request failed')
        if (state.annotations.length > 0) options.onAnnotations?.(state.annotations)
        if (state.stream) {
          options.onText(state.text)
          state.afterChunk()
        }
        return { text: state.text, webLookup: state.webLookup }
      }
    )
  }
})

beforeEach(() => {
  state.settings = structuredClone(DEFAULT_SETTINGS)
  state.settings.captureScreenshotByDefault = false
  state.settings.rememberConversation = false
  state.activeApp = null
  state.text = 'Ответ'
  state.apiKey = 'test-key'
  state.fail = false
  state.stream = false
  state.afterChunk = () => {}
  state.webLookup = false
  state.agentReady = false
  state.onAgentRun = () => {}
  state.agentStop.mockClear()
  state.agentRunGate = null
  state.agentResult = { answer: '', actions: [] }
  state.agentCalls = []
  state.useImage = false
  state.imageRefusedOnce = false
  state.streams = 0
  state.agentNotice = undefined
  state.annotations = []
  state.collectGate = null
  state.collectGates = []
  state.hideApp.mockClear()
  state.allWindows = []
  applyHistorySettings(false, [])
  vi.mocked(helperVisibleBundleIds).mockReset().mockResolvedValue(null)
  vi.mocked(helperFocused).mockReset().mockResolvedValue(null)
})

async function harness(openCard = true) {
  const { createOverlayController } = await import('./index')
  let visible = false
  const send = vi.fn()
  const win = {
    isVisible: () => visible,
    isDestroyed: () => false,
    setContentProtection: vi.fn(),
    focus: vi.fn(),
    webContents: { send }
  } as unknown as BrowserWindow
  const host: OverlayHost = {
    prewarm: vi.fn(),
    show: vi.fn(() => {
      visible = true
    }),
    showInactive: vi.fn(() => {
      visible = true
    }),
    hide: vi.fn(() => {
      visible = false
    }),
    window: () => win,
    resize: vi.fn(),
    setDrawing: vi.fn(),
    setVoice: vi.fn(),
    setPassthrough: vi.fn(),
    focus: vi.fn(),
    showField: vi.fn(),
    hideField: vi.fn()
  }
  const controller = createOverlayController(host)
  if (openCard) await controller.open()
  vi.mocked(host.showInactive).mockClear()
  vi.mocked(host.show).mockClear()
  const request: SendRequest = {
    requestId: 'r1',
    prompt: 'Вопрос',
    mode: 'analyze',
    voice: true,
    includeSelection: false,
    includeScreenshot: false
  }
  return { controller, host, request, send, visible: () => visible }
}

/** A promise the test resolves when the mocked work may finish. */
function gate(): { wait: Promise<void>; release: () => void } {
  let release!: () => void
  const wait = new Promise<void>((resolve) => {
    release = resolve
  })
  return { wait, release }
}

/** The app the capture tests photograph. */
const noteApp: ActiveAppInfo = {
  bundleId: 'com.apple.TextEdit',
  name: 'TextEdit',
  pid: 900,
  windowTitle: 'Заметка',
  windowId: 5,
  bounds: { x: 0, y: 0, width: 800, height: 600 }
}

describe('routing: the agent or the writer', () => {
  it('sends an action request to the agent when the mode is ready', async () => {
    state.agentReady = true
    state.agentResult = {
      answer: 'Экспорт сохранён без вложений.',
      actions: [{ tool: 'click', label: 'Нажал «Экспорт»', ok: true }]
    }
    const h = await harness()

    await h.controller.send({ ...h.request, voice: false, prompt: 'Нажми «Экспорт»' })

    expect(state.agentCalls).toHaveLength(1)
    // The agent sees the same exclusion list the overlay and writer enforce.
    expect(state.agentCalls[0]).toMatchObject({
      excludedApps: state.settings.excludedApps
    })
    // The writer was never called: an action must not pay for a text round whose
    // only job would be to guess what the agent is about to do anyway.
    expect(buildTurnRequest).not.toHaveBeenCalled()
    expect(h.send).toHaveBeenCalledWith(
      'overlay:stream',
      expect.objectContaining({
        type: 'done',
        text: 'Экспорт сохранён без вложений.'
      })
    )
  })

  it('brings back the card for a successful action without a written report', async () => {
    state.agentReady = true
    state.agentResult = { answer: '[[ACTION_DONE]]', actions: [] }
    const h = await harness()

    await h.controller.send({ ...h.request, voice: false, prompt: 'Открой новую вкладку' })

    expect(h.send).toHaveBeenCalledWith(
      'overlay:stream',
      expect.objectContaining({
        type: 'done',
        text: ''
      })
    )
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
    expect(buildTurnRequest).toHaveBeenLastCalledWith(
      expect.objectContaining({
        availability: expect.objectContaining({ ready: false, reason: 'нет доступа' })
      })
    )
    expect(h.send).toHaveBeenCalledWith('overlay:stream', expect.objectContaining({ type: 'done' }))
  })

  it('never routes a rewrite to the agent', async () => {
    state.agentReady = true
    const h = await harness()

    await h.controller.send({
      ...h.request,
      voice: false,
      prompt: 'Нажми',
      refine: { direction: 'shorter', baseAnswer: 'Длинный ответ.' }
    })

    expect(state.agentCalls).toHaveLength(0)
  })
})

describe('an excluded target', () => {
  it('ends the turn with a visible error so the card does not stay busy', async () => {
    state.settings.excludedApps = ['com.apple.Passwords']
    state.activeApp = {
      bundleId: 'com.apple.Passwords',
      name: 'Passwords',
      pid: 99,
      windowTitle: 'Passwords',
      windowId: 11,
      bounds: { x: 100, y: 100, width: 640, height: 480 }
    }
    vi.mocked(buildTurnRequest).mockClear()
    const h = await harness()

    await h.controller.send({ ...h.request, voice: false })

    expect(buildTurnRequest).not.toHaveBeenCalled()
    expect(h.send).toHaveBeenCalledWith(
      'overlay:stream',
      expect.objectContaining({
        type: 'error',
        requestId: 'r1',
        message: expect.stringContaining('исключ')
      })
    )
    expect(h.visible()).toBe(true)
  })
})

describe('screenshot privacy with exclusions configured', () => {
  const SAFARI: ActiveAppInfo = {
    bundleId: 'com.apple.Safari',
    name: 'Safari',
    pid: 42,
    windowTitle: 'Start',
    windowId: 7,
    bounds: { x: 10, y: 20, width: 800, height: 600 }
  }
  const SHOT = {
    dataUrl: 'data:image/jpeg;base64,abc',
    width: 1440,
    height: 900,
    bytes: 3,
    capturedAt: Date.now(),
    area: { x: 0, y: 0, width: 1440, height: 900 },
    fullScreen: true
  }

  async function preparedCapture(
    visibleBundleIds: string[] | null,
    excludedApps = ['com.apple.Passwords']
  ): Promise<CaptureTarget | null> {
    state.settings.excludedApps = excludedApps
    state.activeApp = SAFARI
    vi.mocked(helperVisibleBundleIds).mockReset().mockResolvedValueOnce(visibleBundleIds)
    const h = await harness()
    vi.mocked(captureScreenshot).mockReset().mockResolvedValueOnce(SHOT)
    vi.mocked(buildTurnRequest).mockImplementationOnce(async ({ ensureFreshScreenshot }) => {
      await ensureFreshScreenshot()
      return {
        messages: [],
        maxTokens: 1024,
        area: null,
        screenshot: null,
        useImage: false,
        canDraw: false,
        abandoned: false
      }
    })

    await h.controller.send({ ...h.request, voice: false, includeScreenshot: true })

    return vi.mocked(captureScreenshot).mock.calls[0]?.[0] ?? null
  }

  it('restores the whole display when no excluded app has a window on screen', async () => {
    const capture = await preparedCapture([SAFARI.bundleId, 'com.apple.Finder'])

    expect(capture).toMatchObject({ fullDisplay: true })
    expect(capture?.allowFullScreenFallback).toBeUndefined()
  })

  it('captures only the window when an excluded app has a window on screen', async () => {
    const capture = await preparedCapture(['com.apple.Safari', 'com.apple.Passwords'])

    expect(capture).toMatchObject({ fullDisplay: false, allowFullScreenFallback: false })
  })

  it('stays window-only when the visible list is unknown', async () => {
    const capture = await preparedCapture(null)

    expect(capture).toMatchObject({ fullDisplay: false, allowFullScreenFallback: false })
  })

  it('does not ask for visible apps when nothing is excluded', async () => {
    const capture = await preparedCapture(null, [])

    expect(capture).toMatchObject({ fullDisplay: true })
    expect(helperVisibleBundleIds).not.toHaveBeenCalled()
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
      expect(h.send).toHaveBeenCalledWith(
        'overlay:stream',
        expect.objectContaining({
          type: 'done',
          text: 'Ответ со ссылкой на источник.'
        })
      )
    }
  )

  it('keeps a web failure on the web path', async () => {
    const h = await harness()
    state.webLookup = true
    vi.mocked(searchWeb).mockRejectedValueOnce(new Error('Веб-поиск недоступен'))
    await h.controller.send({ ...h.request, prompt: 'Курс доллара' })

    expect(state.agentCalls).toHaveLength(0)
    expect(h.send).toHaveBeenCalledWith(
      'overlay:stream',
      expect.objectContaining({
        type: 'error',
        message: 'Веб-поиск недоступен'
      })
    )
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
    expect(h.send).toHaveBeenCalledWith(
      'overlay:stream',
      expect.objectContaining({
        type: 'done',
        text: 'Вкладка открыта.'
      })
    )
  })

  it('reports a blocked run as an answer instead of an empty card', async () => {
    const h = await harness()
    state.agentResult = { answer: '', actions: [], message: 'Агентный режим выключен.', blocked: true }

    await h.controller.send({ ...h.request, voice: false, prompt: 'Нажми «ОК»' })

    expect(h.send).toHaveBeenCalledWith(
      'overlay:stream',
      expect.objectContaining({
        type: 'done',
        text: 'Агентный режим выключен.'
      })
    )
  })

  it('says something when the agent stopped without an answer', async () => {
    const h = await harness()
    state.agentResult = {
      answer: '',
      actions: [{ tool: 'click', label: 'Нажал', ok: true }],
      aborted: true,
      message: 'Остановлено.'
    }

    await h.controller.send({ ...h.request, voice: false, prompt: 'Нажми «ОК»' })

    expect(h.send).toHaveBeenCalledWith(
      'overlay:stream',
      expect.objectContaining({
        type: 'done',
        text: 'Остановлено.'
      })
    )
  })
})

describe('stopping the agent with the turn', () => {
  beforeEach(() => {
    state.agentReady = true
  })

  it('stops the run when the card cancels the turn', async () => {
    const h = await harness()
    const run = gate()
    state.agentRunGate = run.wait
    const sending = h.controller.send({ ...h.request, voice: false, prompt: 'Нажми «Экспорт»' })
    await vi.waitFor(() => expect(state.agentCalls).toHaveLength(1))
    // Starting a turn stops the plan of the previous one; this stop belongs to
    // the turn under test.
    state.agentStop.mockClear()

    h.controller.cancel('r1')

    // The run does not learn about the abort on its own: without the stop it
    // keeps clicking after the card said the turn was over.
    expect(state.agentStop).toHaveBeenCalledOnce()
    run.release()
    await sending
  })

  it('stops the run when a new voice press supersedes the turn', async () => {
    const h = await harness()
    const run = gate()
    state.agentRunGate = run.wait
    const sending = h.controller.send({ ...h.request, prompt: 'Нажми «Экспорт»' })
    await vi.waitFor(() => expect(state.agentCalls).toHaveLength(1))
    state.agentStop.mockClear()

    h.controller.setVoice(true)

    expect(state.agentStop).toHaveBeenCalledOnce()
    run.release()
    await sending
  })

  it('stops the run when the turn deadline expires', async () => {
    const h = await harness()
    const run = gate()
    state.agentRunGate = run.wait
    vi.useFakeTimers()
    try {
      const sending = h.controller.send({ ...h.request, voice: false, prompt: 'Нажми «Экспорт»' })
      await vi.advanceTimersByTimeAsync(0)
      state.agentStop.mockClear()

      await vi.advanceTimersByTimeAsync(120_000)

      expect(state.agentStop).toHaveBeenCalledOnce()
      run.release()
      await sending
      expect(h.send).toHaveBeenCalledWith(
        'overlay:stream',
        expect.objectContaining({
          type: 'error',
          code: 'timeout',
          message: 'Время выполнения истекло. Результат не подтверждён.'
        })
      )
    } finally {
      vi.useRealTimers()
    }
  })

  it('leaves the agent alone when a writer turn is cancelled', async () => {
    const h = await harness()
    const round = gate()
    vi.mocked(consumeTurnStream).mockImplementationOnce(async () => {
      await round.wait
      return { text: 'Ответ', webLookup: false }
    })
    const sending = h.controller.send({ ...h.request, voice: false, prompt: 'Что это за кнопка?' })
    await vi.waitFor(() => expect(consumeTurnStream).toHaveBeenCalled())
    state.agentStop.mockClear()

    h.controller.cancel('r1')

    // The writer's controller has no agent run of its own; stopping the agent
    // here would end a run that belongs to somebody else.
    expect(state.agentStop).not.toHaveBeenCalled()
    round.release()
    await sending
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
    expect(h.send).toHaveBeenCalledWith(
      'overlay:stream',
      expect.objectContaining({
        type: 'done',
        text: 'Ответ'
      })
    )
  })

  it('says why the answer has no drawing', async () => {
    state.useImage = true
    state.imageRefusedOnce = true
    const h = await harness()

    await h.controller.send({ ...h.request, voice: false })

    const stateEvent = h.send.mock.calls.filter(([channel]) => channel === 'overlay:state').at(-1)?.[1] as
      { warnings: string[] } | undefined
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

    const stateEvent = h.send.mock.calls.filter(([channel]) => channel === 'overlay:state').at(-1)?.[1] as
      { warnings: string[] } | undefined
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
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
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
      dataUrl: 'data:image/jpeg;base64,abc',
      width: 1440,
      height: 900,
      bytes: 3,
      capturedAt: Date.now(),
      area: { x: 0, y: 0, width: 1440, height: 900 },
      fullScreen: true
    }
    vi.mocked(captureScreenshot).mockClear().mockResolvedValueOnce(shot)
    vi.mocked(getProvider).mockClear()
    const prepare = vi.fn<typeof buildTurnRequest>(async ({ ensureFreshScreenshot }) => {
      expect(await ensureFreshScreenshot()).toBe(shot)
      return {
        messages: [],
        maxTokens: 1024,
        area: shot.area,
        screenshot: shot,
        useImage: true,
        canDraw: true,
        abandoned: false
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
    expect(h.send).toHaveBeenCalledWith(
      'overlay:stream',
      expect.objectContaining({
        type: 'done',
        text: expect.stringContaining('Не удалось выполнить запрос')
      })
    )
  })

  it('shows a failed request instead of leaving its error in an invisible panel', async () => {
    const h = await harness()
    h.host.hide()
    state.fail = true
    await h.controller.send(h.request)
    expect(h.visible()).toBe(true)
    expect(h.send).toHaveBeenCalledWith(
      'overlay:stream',
      expect.objectContaining({ type: 'error', message: 'Request failed' })
    )
  })

  it('does not hide an empty result of a typed request', async () => {
    const h = await harness()
    state.text = ''
    await h.controller.send({ ...h.request, voice: false })
    expect(h.visible()).toBe(true)
    expect(h.host.hide).not.toHaveBeenCalled()
  })
})

describe('dictation without the card', () => {
  const textEdit: ActiveAppInfo = {
    bundleId: 'com.apple.TextEdit',
    name: 'TextEdit',
    pid: 900,
    windowTitle: 'Заметка',
    windowId: 5,
    bounds: null
  }

  function front(bundleId: string, pid: number): RawFrontApp {
    return {
      bundleId,
      name: bundleId,
      pid,
      windowId: null,
      windowTitle: null,
      bounds: null,
      accessibility: true
    }
  }

  beforeEach(() => {
    vi.mocked(helperFrontApplication).mockReset()
    vi.mocked(helperActivate).mockReset().mockResolvedValue(true)
  })

  it('remembers the front app without opening or focusing the card', async () => {
    vi.mocked(helperFrontApplication).mockResolvedValue(front('com.apple.TextEdit', 900))
    const h = await harness(false)

    await h.controller.beginDictation()

    expect(h.controller.target()).toEqual({
      bundleId: 'com.apple.TextEdit',
      name: 'com.apple.TextEdit',
      pid: 900,
      windowTitle: null,
      windowId: null,
      bounds: null
    })
    expect(h.host.show).not.toHaveBeenCalled()
    expect(h.host.showInactive).not.toHaveBeenCalled()
    expect(h.visible()).toBe(false)
  })

  it('marks the editable field that will receive the dictation', async () => {
    vi.mocked(helperFrontApplication).mockResolvedValue(front('com.apple.TextEdit', 900))
    vi.mocked(helperFocused).mockResolvedValue({
      role: 'AXTextArea',
      frame: { x: 10, y: 20, width: 300, height: 24 },
      pressable: false,
      editable: true
    })
    const h = await harness(false)

    await h.controller.beginDictation()

    expect(helperFocused).toHaveBeenCalledWith(900)
    await vi.waitFor(() =>
      expect(h.host.showField).toHaveBeenCalledWith({
        x: 10,
        y: 20,
        width: 300,
        height: 24
      })
    )
  })

  it('does not mark a focused element that cannot take text', async () => {
    vi.mocked(helperFrontApplication).mockResolvedValue(front('com.apple.TextEdit', 900))
    vi.mocked(helperFocused).mockResolvedValue({
      role: 'AXButton',
      frame: { x: 10, y: 20, width: 300, height: 24 },
      pressable: true,
      editable: false
    })
    const h = await harness(false)

    await h.controller.beginDictation()

    await vi.waitFor(() => expect(h.host.showField).toHaveBeenCalledWith(null))
  })

  it('ignores a focused element owned by the card itself', async () => {
    vi.mocked(helperFrontApplication).mockResolvedValue(front('com.apple.TextEdit', 900))
    vi.mocked(helperFocused).mockResolvedValue({
      role: 'AXTextArea',
      frame: { x: 10, y: 20, width: 300, height: 24 },
      pressable: false,
      editable: true,
      pid: process.pid
    })
    const h = await harness(false)

    await h.controller.beginDictation()

    await vi.waitFor(() => expect(h.host.showField).toHaveBeenCalledWith(null))
  })

  it('uses the app behind a frontmost card', async () => {
    state.activeApp = textEdit
    const h = await harness()
    vi.mocked(helperFrontApplication).mockResolvedValue(front('com.bobr.deskhand', process.pid))

    await h.controller.beginDictation()

    expect(h.controller.target()).toEqual(textEdit)
  })

  it('reads the app in front even when a card is open behind it', async () => {
    state.activeApp = textEdit
    const h = await harness()
    vi.mocked(helperFrontApplication).mockResolvedValue(front('com.apple.Safari', 12))

    await h.controller.beginDictation()

    expect(h.controller.target()).toMatchObject({ bundleId: 'com.apple.Safari', pid: 12 })
  })

  it('hides only the bars when the hold never opened a card', async () => {
    vi.mocked(helperFrontApplication).mockResolvedValue(front('com.apple.TextEdit', 900))
    const h = await harness(false)
    await h.controller.beginDictation()
    h.host.showInactive(31)

    h.controller.endDictation()

    expect(h.host.hide).toHaveBeenCalled()
    expect(h.controller.target()).toBeNull()
    expect(helperActivate).not.toHaveBeenCalled()
  })

  it('removes the field mark when the hold ends', async () => {
    vi.mocked(helperFrontApplication).mockResolvedValue(front('com.apple.TextEdit', 900))
    const h = await harness(false)
    await h.controller.beginDictation()

    h.controller.endDictation()

    expect(h.host.hideField).toHaveBeenCalled()
  })

  it('closes and returns focus for a primary dictation that opened the card', async () => {
    state.activeApp = textEdit
    const h = await harness()
    expect(h.visible()).toBe(true)

    h.controller.endDictation(true)

    expect(h.visible()).toBe(false)
    await vi.waitFor(() =>
      expect(helperActivate).toHaveBeenCalledWith({
        bundleId: 'com.apple.TextEdit',
        pid: 900
      })
    )
  })

  it('closes a card that owned the keyboard and gives focus back to its app', async () => {
    state.activeApp = textEdit
    const h = await harness()
    vi.mocked(helperFrontApplication).mockResolvedValue(front('com.bobr.deskhand', process.pid))
    await h.controller.beginDictation()

    h.controller.endDictation()

    expect(h.visible()).toBe(false)
    await vi.waitFor(() =>
      expect(helperActivate).toHaveBeenCalledWith({
        bundleId: 'com.apple.TextEdit',
        pid: 900
      })
    )
  })

  it('does not let a card that is still opening take the keyboard', async () => {
    let release = (): void => undefined
    state.collectGate = new Promise<void>((resolve) => {
      release = resolve
    })
    vi.mocked(helperFrontApplication).mockResolvedValue(front('com.apple.TextEdit', 900))
    const h = await harness(false)
    const opening = h.controller.open()
    await vi.waitFor(() => expect(h.host.showInactive).toHaveBeenCalled())
    vi.mocked(h.host.showInactive).mockClear()

    await h.controller.beginDictation()
    h.host.showInactive(31)
    release()
    await opening

    expect(h.host.show).not.toHaveBeenCalled()
    // The bars that the dictation just put up are not hidden by the stale open.
    expect(h.host.hide).not.toHaveBeenCalled()
    h.controller.endDictation()
  })

  it('drops a target that arrives after the hold has ended', async () => {
    let release = (): void => undefined
    const read = new Promise<RawFrontApp | null>((resolve) => {
      release = () => resolve(front('com.apple.TextEdit', 900))
    })
    vi.mocked(helperFrontApplication).mockReturnValue(read)
    const h = await harness(false)
    const pending = h.controller.beginDictation()

    h.controller.endDictation()
    release()
    await pending

    expect(h.controller.target()).toBeNull()
  })

  it('does not fall back to an old card target while the dictation app is being read', async () => {
    state.activeApp = textEdit
    const h = await harness()
    let release = (): void => undefined
    const read = new Promise<RawFrontApp | null>((resolve) => {
      release = () => resolve(front('com.apple.Safari', 12))
    })
    vi.mocked(helperFrontApplication).mockReturnValue(read)

    const pending = h.controller.beginDictation()
    expect(h.controller.target()).toBeNull()

    release()
    await pending
    expect(h.controller.target()).toMatchObject({ bundleId: 'com.apple.Safari', pid: 12 })
  })

  it('forgets the remembered app so the next hold reads the screen again', async () => {
    vi.mocked(helperFrontApplication).mockResolvedValue(front('com.apple.TextEdit', 900))
    const h = await harness(false)
    await h.controller.beginDictation()
    h.controller.endDictation()
    vi.mocked(helperFrontApplication).mockResolvedValue(front('com.apple.Safari', 12))

    await h.controller.beginDictation()

    expect(h.controller.target()).toMatchObject({ bundleId: 'com.apple.Safari', pid: 12 })
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
    expect(buildTurnRequest).toHaveBeenLastCalledWith(
      expect.objectContaining({
        previousCommand: h.request.prompt,
        history: []
      })
    )

    await h.controller.send({ ...h.request, requestId: 'r3', prompt: 'Что дальше?' })
    expect(buildTurnRequest).toHaveBeenLastCalledWith(
      expect.objectContaining({
        previousCommand: undefined,
        history: [
          expect.objectContaining({
            question: 'Повтори',
            answer: state.text
          })
        ]
      })
    )
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
    expect(beginAgentTurn).toHaveBeenCalledWith(true)
    expect(endAgentTurn).toHaveBeenCalledWith(42)
    expect(h.send).toHaveBeenCalledWith(
      'overlay:stream',
      expect.objectContaining({
        type: 'done',
        text: 'Context unavailable'
      })
    )
  })
})

describe('a press that follows Escape', () => {
  it('starts a fresh open instead of joining the one the close doomed', async () => {
    const doomed = gate()
    const fresh = gate()
    state.collectGates = [doomed.wait, fresh.wait]
    const h = await harness(false)

    const first = h.controller.open()
    await vi.waitFor(() => expect(state.collectGates).toHaveLength(1))

    h.controller.close()
    vi.mocked(h.host.hide).mockClear()
    const second = h.controller.open()

    // The fresh open wins the screen first, then the doomed one settles. It must
    // not take down the card the press after Escape just put up.
    fresh.release()
    doomed.release()
    await Promise.all([first, second])

    expect(h.controller.isOpen()).toBe(true)
    expect(h.controller.state()).not.toBeNull()
    expect(h.host.hide).not.toHaveBeenCalled()
  })

  it('shares one context collection between two presses of the same card', async () => {
    const only = gate()
    state.collectGates = [only.wait]
    const h = await harness(false)

    const first = h.controller.open()
    const second = h.controller.open()
    expect(second).toBe(first)

    only.release()
    await first

    expect(h.controller.isOpen()).toBe(true)
  })
})

describe('a transcript with no card', () => {
  it('drops the words when the card was dismissed before they arrived', async () => {
    const h = await harness()
    h.controller.close()
    h.send.mockClear()

    h.controller.deliver('привет', { submit: true })

    // Escape ended the turn; recognition keeps running and its result belongs
    // to nobody. Typing it into the hidden renderer would bring the card back
    // with an answer to the phrase the user just closed.
    expect(h.send).not.toHaveBeenCalledWith('voice:transcript', expect.anything())
  })

  it('drops the words when the open it waited for was doomed', async () => {
    const pending = gate()
    state.collectGates = [pending.wait]
    const h = await harness(false)
    const opening = h.controller.open()
    h.controller.deliver('привет', { submit: true })

    h.controller.close()
    vi.mocked(h.host.hide).mockClear()
    pending.release()
    await opening

    expect(h.send).not.toHaveBeenCalledWith('voice:transcript', expect.anything())
  })

  it('still types the words into a card that is on screen', async () => {
    const h = await harness()

    h.controller.deliver('привет', { submit: false })

    expect(h.send).toHaveBeenCalledWith('voice:transcript', { text: 'привет', send: false })
  })
})

describe('a capture that no longer represents the screen', () => {
  type Harness = Awaited<ReturnType<typeof harness>>

  /** The last context the controller published to the card. */
  function lastContextUpdate(h: Harness): { screenshot: ScreenshotInfo | null } | undefined {
    return h.send.mock.calls.filter(([channel]) => channel === CH.overlay.contextUpdate).at(-1)?.[1] as
      { screenshot: ScreenshotInfo | null } | undefined
  }

  /** A frame old enough that the next request has to take a new one. */
  const staleShot = (): ScreenshotInfo => ({
    dataUrl: 'data:image/jpeg;base64,b2xk',
    width: 800,
    height: 600,
    bytes: 3,
    capturedAt: Date.now() - 5_000,
    area: { x: 0, y: 0, width: 800, height: 600 },
    fullScreen: true
  })

  /** Swaps the built request for one that reports what the refresh returned. */
  function readFreshScreenshot(): () => ScreenshotInfo | null | undefined {
    let fresh: ScreenshotInfo | null | undefined
    vi.mocked(buildTurnRequest).mockImplementationOnce(async ({ ensureFreshScreenshot }) => {
      fresh = await ensureFreshScreenshot()
      return {
        messages: [],
        maxTokens: 1024,
        area: null,
        canDraw: false,
        useImage: false,
        screenshot: null,
        abandoned: false
      }
    })
    return () => fresh
  }

  beforeEach(() => {
    vi.mocked(captureScreenshot).mockReset()
    vi.mocked(buildTurnRequest).mockClear()
  })

  it('sends no image at all when the refresh fails', async () => {
    state.activeApp = noteApp
    vi.mocked(captureScreenshot).mockResolvedValueOnce(staleShot()).mockResolvedValue(null)
    const h = await harness()

    // The first turn is the one that puts a frame in the session.
    const saved = readFreshScreenshot()
    await h.controller.send({ ...h.request, includeScreenshot: true })
    expect(saved()?.dataUrl).toBe(staleShot().dataUrl)
    expect(h.controller.state()?.context.screenshot).toEqual(saved())

    // The next capture fails (Screen Recording, a closed window): the session
    // keeps the old frame in the preview, but the turn must not be told it is
    // the screen as it is now.
    const fresh = readFreshScreenshot()
    await h.controller.send({ ...h.request, requestId: 'r2', includeScreenshot: true })

    expect(captureScreenshot).toHaveBeenCalledTimes(2)
    expect(fresh()).toBeNull()
  })

  it('tells the card when the capture target is refused', async () => {
    vi.useFakeTimers()
    try {
      state.activeApp = noteApp
      vi.mocked(captureScreenshot).mockResolvedValueOnce(staleShot())
      const h = await harness()

      h.controller.setFlags({ includeSelection: false, includeScreenshot: true })
      await vi.waitFor(() => expect(lastContextUpdate(h)?.screenshot?.dataUrl).toBe(staleShot().dataUrl))

      // The app moves onto the exclusion list, so nothing may be photographed any
      // more. The live refresh has to tell the card that the frame it shows is
      // gone, or the thumbnail keeps promising a screenshot the session lost.
      state.settings.excludedApps = [noteApp.bundleId]
      h.send.mockClear()
      await vi.advanceTimersByTimeAsync(2_000)

      expect(lastContextUpdate(h)?.screenshot).toBeNull()
      expect(h.controller.state()?.context.screenshot).toBeNull()
      h.controller.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('drops the shapes together with a refused frame', async () => {
    state.activeApp = noteApp
    state.annotations = [{ kind: 'circle', from: { x: 0.1, y: 0.2 }, to: { x: 0.3, y: 0.4 } }]
    vi.mocked(captureScreenshot).mockResolvedValueOnce(staleShot())
    vi.mocked(buildTurnRequest).mockImplementationOnce(async ({ ensureFreshScreenshot }) => {
      await ensureFreshScreenshot()
      return {
        messages: [],
        maxTokens: 1024,
        area: staleShot().area,
        canDraw: true,
        useImage: true,
        screenshot: null,
        abandoned: false
      }
    })
    const h = await harness()
    const drawn = (): number | undefined =>
      (
        h.send.mock.calls.filter(([channel]) => channel === CH.overlay.annotations).at(-1)?.[1] as
          { count: number } | undefined
      )?.count

    // A turn leaves one shape on the screen next to the frame it was measured
    // against.
    await h.controller.send({ ...h.request, includeScreenshot: true })
    expect(drawn()).toBe(1)

    // The app moves onto the exclusion list, so the refresh cannot photograph it:
    // the frame goes, and the shape has no meaning without it.
    state.settings.excludedApps = [noteApp.bundleId]
    vi.mocked(helperFrontApplication).mockResolvedValue({
      bundleId: 'com.bobr.deskhand',
      name: 'Deskhand',
      pid: process.pid,
      windowId: null,
      windowTitle: null,
      bounds: null,
      accessibility: true
    })
    h.send.mockClear()
    await h.controller.open()

    await vi.waitFor(() => expect(lastContextUpdate(h)?.screenshot).toBeNull())
    expect(drawn()).toBe(0)
    // One publish for the cleared state: the shape and the frame go together.
    expect(h.send.mock.calls.filter(([channel]) => channel === CH.overlay.contextUpdate)).toHaveLength(1)
    expect(h.controller.state()?.context.screenshot).toBeNull()
    h.controller.close()
  })
})

describe('focus on the way back', () => {
  beforeEach(() => {
    vi.mocked(helperActivate).mockReset()
  })

  /** Another app window that could take the keyboard back. */
  function otherWindow(focusable = true) {
    return {
      isDestroyed: () => false,
      isVisible: () => true,
      isFocusable: () => focusable,
      show: vi.fn(),
      focus: vi.fn()
    }
  }

  it('asks the helper to activate the app the card was opened over', async () => {
    state.activeApp = noteApp
    vi.mocked(helperActivate).mockResolvedValue(true)
    const h = await harness()

    h.controller.close()

    await vi.waitFor(() =>
      expect(helperActivate).toHaveBeenCalledWith({ bundleId: noteApp.bundleId, pid: noteApp.pid })
    )
    expect(state.hideApp).not.toHaveBeenCalled()
  })

  it('focuses a visible, focusable window when there is no app to return to', async () => {
    const h = await harness()
    const fallback = otherWindow()
    state.allWindows = [fallback as unknown as BrowserWindow]

    h.controller.close()

    await vi.waitFor(() => expect(fallback.focus).toHaveBeenCalledOnce())
    expect(fallback.show).toHaveBeenCalledOnce()
    expect(helperActivate).not.toHaveBeenCalled()
    expect(state.hideApp).not.toHaveBeenCalled()
  })

  it('hides the app when the only other window cannot take the keyboard', async () => {
    const h = await harness()
    const layer = otherWindow(false)
    state.allWindows = [layer as unknown as BrowserWindow]

    h.controller.close()

    await vi.waitFor(() => expect(state.hideApp).toHaveBeenCalledOnce())
    expect(layer.focus).not.toHaveBeenCalled()
  })

  it('does not raise a fallback window after a newer card took the keyboard', async () => {
    state.activeApp = noteApp
    let release!: () => void
    const activation = new Promise<boolean>((resolve) => {
      release = () => resolve(false)
    })
    vi.mocked(helperActivate).mockReturnValueOnce(activation)
    const h = await harness()
    const fallback = otherWindow()
    state.allWindows = [fallback as unknown as BrowserWindow]

    h.controller.close()
    await h.controller.open()
    release()
    // Let the hand-back resume after the helper answered.
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(fallback.show).not.toHaveBeenCalled()
    expect(fallback.focus).not.toHaveBeenCalled()
    expect(state.hideApp).not.toHaveBeenCalled()
  })

  it('does not hide a card that opened while focus was going back', async () => {
    state.activeApp = noteApp
    let release!: () => void
    const activation = new Promise<boolean>((resolve) => {
      release = () => resolve(false)
    })
    vi.mocked(helperActivate).mockReturnValueOnce(activation)
    const h = await harness()

    h.controller.close()
    expect(helperActivate).toHaveBeenCalledTimes(1)
    // The press lands while the helper is still loading the app to activate.
    await h.controller.open()
    release()
    // Let the hand-back finish before asking whether it touched the screen.
    await new Promise((resolve) => setTimeout(resolve, 0))

    // Focus already went to the new card: hiding ourselves now would make the
    // fresh press look like it did nothing.
    expect(h.controller.isOpen()).toBe(true)
    expect(state.hideApp).not.toHaveBeenCalled()
  })
})
