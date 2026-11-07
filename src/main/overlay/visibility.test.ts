import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'
import { DEFAULT_SETTINGS } from '@shared/defaults'
import type { AppSettings, SendRequest } from '@shared/types'
import { beginAgentTurn, endAgentTurn } from '../agent/cursor'
import { captureScreenshot } from '../context/screenshot'
import { getProvider } from '../llm'
import { searchWeb } from '../llm/webSearch'
import { buildTurnRequest } from './request'
import { runAgentRounds } from './rounds'
import { verifyResult } from './verify'
import { applyHistorySettings } from './history'
import { delay } from '../util'
import type { OverlayHost } from './host'

const state = vi.hoisted(() => ({
  settings: {} as AppSettings, text: 'Ответ', suppressed: false, apiKey: 'test-key', fail: false,
  stream: false, afterChunk: () => {}, webLookup: false,
  verification: null as { evidence: string; corrected?: boolean; observed?: boolean } | null
}))
vi.mock('electron', () => ({ app: {}, BrowserWindow: {} }))
vi.mock('electron-store', () => ({ default: class {
  store = {}
} }))
vi.mock('../settings/store', () => ({ getSettings: () => state.settings }))
vi.mock('../settings/secrets', () => ({ getApiKey: () => state.apiKey }))
vi.mock('../native/helper', () => ({ helperFront: vi.fn(), helperActivate: vi.fn() }))
vi.mock('../paste', () => ({ copyText: vi.fn(), pasteAnswer: vi.fn() }))
vi.mock('../pointer', () => ({ hideAnnotations: vi.fn(), showAnnotations: vi.fn() }))
vi.mock('../context/screenshot', () => ({ captureScreenshot: vi.fn() }))
vi.mock('../agent/outline', () => ({ describeScreen: vi.fn() }))
vi.mock('../agent/cursor', () => ({ beginAgentTurn: vi.fn(), endAgentTurn: vi.fn(), updateAgentCursor: vi.fn() }))
vi.mock('../agent', () => ({
  createAgentController: () => ({ stop: vi.fn(), availability: () => ({ enabled: true, ready: true, reason: null }) })
}))
vi.mock('../context/collect', () => ({
  collectContext: async () => ({
    snapshot: { activeApp: null, selection: null, screenshot: null, warnings: [], excluded: false },
    flags: { includeSelection: false, includeScreenshot: false }
  })
}))
vi.mock('../llm', () => ({ resolveModel: () => 'gpt-4o', getProvider: vi.fn() }))
vi.mock('../llm/webSearch', () => ({ searchWeb: vi.fn() }))
vi.mock('../util', () => ({ delay: vi.fn().mockResolvedValue(undefined) }))
vi.mock('./request', () => ({
  buildTurnRequest: vi.fn(async () => ({
    messages: [], maxTokens: 1024, area: null, canDraw: false, canAct: false, holdFirstRound: !state.stream
  }))
}))
vi.mock('../turnStream', () => ({ consumeTurnStream: async (options: { onText: (text: string) => void }) => {
  if (state.fail) throw new Error('Request failed')
  if (state.stream) { options.onText(state.text); state.afterChunk() }
  return {
    steps: state.webLookup ? [{ action: { kind: 'look' } }] : [],
    text: state.text, webLookup: state.webLookup
  }
} }))
vi.mock('./rounds', () => ({ runAgentRounds: vi.fn(async () => ({
  held: state.verification || (!state.suppressed && !state.stream) ? state.text : '',
  suppressed: state.suppressed,
  performedLines: state.verification ? ['Открыл сообщения'] : [],
  interrupted: false, claimedDone: Boolean(state.verification?.observed),
  confirmedOnScreen: Boolean(state.verification?.observed), willVerify: Boolean(state.verification)
})) }))
vi.mock('./verify', async (importOriginal) => ({
  ...await importOriginal<typeof import('./verify')>(),
  verifyResult: vi.fn(async ({ performedLines }: { performedLines: string[] }) => {
    if (state.verification?.corrected) performedLines.push('Обновил сообщения')
    return { outcome: 'confirmed', evidence: state.verification?.evidence ?? '' }
  })
}))

beforeEach(() => {
  state.settings = structuredClone(DEFAULT_SETTINGS)
  state.settings.captureScreenshotByDefault = false
  state.settings.rememberConversation = false
  state.text = 'Ответ'
  state.suppressed = false
  state.apiKey = 'test-key'
  state.fail = false
  state.stream = false
  state.afterChunk = () => {}
  state.webLookup = false
  state.verification = null
  applyHistorySettings(false, [])
})

describe('background web lookup', () => {
  beforeEach(() => {
    vi.mocked(buildTurnRequest).mockClear()
    vi.mocked(runAgentRounds).mockClear()
    vi.mocked(searchWeb).mockReset().mockResolvedValue('Ответ со ссылкой на источник.')
  })

  it.each(['Курс ЦБ на сегодня', 'Когда открывается выставка?', 'Поищи расписание рейсов'])(
    'routes the model’s web decision to the search tool for %s',
    async (prompt) => {
      const h = await harness()
      state.webLookup = true
      await h.controller.send({ ...h.request, prompt, includeScreenshot: true })

      expect(searchWeb).toHaveBeenCalledWith(prompt, state.settings, 'test-key', expect.any(AbortSignal))
      expect(runAgentRounds).not.toHaveBeenCalled()
      expect(h.send).toHaveBeenCalledWith('overlay:stream', expect.objectContaining({
        type: 'done', text: 'Ответ со ссылкой на источник.'
      }))
    }
  )

  it('chooses web search over an accompanying screen plan', async () => {
    const h = await harness()
    state.webLookup = true
    await h.controller.send({ ...h.request, prompt: 'Когда следующий матч Спартака?' })

    expect(searchWeb).toHaveBeenCalledOnce()
    expect(runAgentRounds).not.toHaveBeenCalled()
  })

  it('routes an instruction to open YouTube to the agent path', async () => {
    const h = await harness()
    state.webLookup = true
    await h.controller.send({ ...h.request, prompt: 'Открой YouTube' })

    expect(searchWeb).not.toHaveBeenCalled()
    expect(runAgentRounds).toHaveBeenCalledOnce()
  })

  it('keeps a web failure on the web path', async () => {
    const h = await harness()
    state.webLookup = true
    vi.mocked(searchWeb).mockRejectedValueOnce(new Error('Веб-поиск недоступен'))
    await h.controller.send({ ...h.request, prompt: 'Курс доллара' })

    expect(runAgentRounds).not.toHaveBeenCalled()
    expect(h.send).toHaveBeenCalledWith('overlay:stream', expect.objectContaining({
      type: 'error', message: 'Веб-поиск недоступен'
    }))
  })
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

describe('voice result visibility', () => {
  it.each([false, true])('keeps the transcript visible before sending (superseded: %s)', async (superseded) => {
    const h = await harness()
    let finishPreview!: () => void
    vi.mocked(delay).mockReturnValueOnce(new Promise<void>((resolve) => {
      finishPreview = resolve
    }))
    const sending = h.controller.send(h.request)

    expect(delay).toHaveBeenLastCalledWith(2_000)
    expect(h.visible()).toBe(true)
    expect(h.send).not.toHaveBeenCalledWith('overlay:stream', expect.anything())
    if (superseded) h.controller.setVoice(true)
    finishPreview()
    await sending

    if (superseded) {
      expect(h.host.hide).not.toHaveBeenCalled()
      expect(h.send).not.toHaveBeenCalledWith('overlay:stream', expect.anything())
    } else {
      expect(h.send).toHaveBeenCalledWith('overlay:stream', expect.objectContaining({ type: 'done' }))
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

  it.each([false, true])('prepares a protected screenshot during preview (cancelled: %s)', async (cancelled) => {
    const h = await harness()
    const shot = {
      dataUrl: 'data:image/jpeg;base64,abc', width: 1440, height: 900, bytes: 3,
      capturedAt: Date.now(), area: { x: 0, y: 0, width: 1440, height: 900 }, fullScreen: true
    }
    vi.mocked(captureScreenshot).mockClear().mockResolvedValueOnce(shot)
    vi.mocked(getProvider).mockClear()
    let finishPreview!: () => void
    vi.mocked(delay).mockReturnValueOnce(new Promise<void>((resolve) => { finishPreview = resolve }))
    const prepare = vi.fn<typeof buildTurnRequest>(async ({ ensureFreshScreenshot }) => {
      expect(await ensureFreshScreenshot()).toBe(shot)
      return {
        messages: [], maxTokens: 1024, area: shot.area, screenshot: shot, useImage: true,
        canDraw: true, canAct: false, holdFirstRound: false, abandoned: false
      }
    })

    const sending = h.controller.send({ ...h.request, includeScreenshot: true })
    await vi.waitFor(() => expect(captureScreenshot).toHaveBeenCalledOnce())
    expect(h.host.window()?.setContentProtection).toHaveBeenCalledWith(true)
    expect(h.visible()).toBe(true)
    expect(getProvider).not.toHaveBeenCalled()

    if (cancelled) h.controller.setVoice(true)
    else vi.mocked(buildTurnRequest).mockImplementationOnce(prepare)
    finishPreview()
    await sending
    expect(captureScreenshot).toHaveBeenCalledOnce()
    expect(prepare).toHaveBeenCalledTimes(cancelled ? 0 : 1)
    expect(getProvider).toHaveBeenCalledTimes(cancelled ? 0 : 1)
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

  it('keeps action narration suppressed and hides the empty result panel', async () => {
    const h = await harness()
    state.suppressed = true
    await h.controller.send(h.request)
    expect(h.visible()).toBe(false)
    expect(h.send).toHaveBeenCalledWith('overlay:stream', expect.objectContaining({ type: 'done', text: '' }))
  })

  it.each([false, true])('brings the verified report to the front (voice: %s)', async (voice) => {
    const h = await harness()
    state.verification = { evidence: 'Два новых сообщения от Анны.' }
    state.text = 'Открываю сообщения…'
    state.stream = !voice
    await h.controller.send({ ...h.request, voice, prompt: 'Проверь сообщения' })

    expect(h.host.showInactive).toHaveBeenCalledOnce()
    expect(h.visible()).toBe(true)
    expect(h.send).toHaveBeenCalledWith('overlay:stream', expect.objectContaining({
      type: 'done', text: 'Два новых сообщения от Анны.'
    }))
  })

  it.each([false, true])('uses the prior report only if verification made no corrections (corrected: %s)', async (corrected) => {
    const h = await harness()
    state.verification = { evidence: '', corrected }
    state.text = 'Одно новое сообщение.'
    await h.controller.send(h.request)

    expect(h.visible()).toBe(!corrected)
    expect(h.send).toHaveBeenCalledWith('overlay:stream', expect.objectContaining({
      type: 'done', text: corrected ? '' : state.text
    }))
  })

  it('reports the verified continuation without requesting another check', async () => {
    const h = await harness()
    vi.mocked(verifyResult).mockClear()
    state.verification = { observed: true, evidence: '' }
    state.text = 'Настройки открыты.'

    await h.controller.send(h.request)

    expect(verifyResult).not.toHaveBeenCalled()
    expect(h.send).toHaveBeenCalledWith('agent:event', expect.objectContaining({
      phase: 'done', completed: true
    }))
    expect(h.send).toHaveBeenCalledWith('overlay:stream', expect.objectContaining({
      type: 'done', text: 'Настройки открыты.'
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
  it.each([false, true])('remembers the prior request after reopening (action: %s)', async (action) => {
    state.settings.rememberConversation = true
    state.suppressed = action
    const h = await harness()
    await h.controller.send(h.request)
    // Voice actions hide their own card. Text answers can be dismissed normally.
    if (!action) h.host.hide()
    const previousSession = h.controller.state()?.sessionId
    await h.controller.open()
    expect(h.controller.state()?.sessionId).not.toBe(previousSession)

    state.suppressed = false
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
  it('claims the ring before a slow context read and releases it on preparation failure', async () => {
    const h = await harness()
    vi.mocked(beginAgentTurn).mockClear().mockReturnValueOnce(42)
    vi.mocked(endAgentTurn).mockClear()
    vi.mocked(buildTurnRequest).mockImplementationOnce(async () => {
      expect(beginAgentTurn).toHaveBeenCalledWith('Задача принята · готовлю действия…')
      throw new Error('Context unavailable')
    })
    await h.controller.send({ ...h.request, voice: false, prompt: 'Открой новую вкладку' })
    expect(endAgentTurn).toHaveBeenCalledWith(42)
    expect(h.send).toHaveBeenCalledWith('overlay:stream', expect.objectContaining({ type: 'error', message: 'Context unavailable' }))
  })
})
