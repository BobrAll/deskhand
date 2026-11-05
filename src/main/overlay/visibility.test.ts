import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'
import { DEFAULT_SETTINGS } from '@shared/defaults'
import type { AppSettings, SendRequest } from '@shared/types'
import { beginAgentTurn, endAgentTurn } from '../agent/cursor'
import { buildTurnRequest } from './request'
import { delay } from '../util'
import type { OverlayHost } from './host'

const state = vi.hoisted(() => ({
  settings: {} as AppSettings, text: 'Ответ', suppressed: false, apiKey: 'test-key', fail: false,
  stream: false, afterChunk: () => {}
}))
vi.mock('electron', () => ({ app: {}, BrowserWindow: {} }))
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
vi.mock('../util', () => ({ delay: vi.fn() }))
vi.mock('./request', () => ({
  buildTurnRequest: vi.fn(async () => ({
    messages: [], maxTokens: 1024, area: null, canDraw: false, canAct: false, holdFirstRound: !state.stream
  }))
}))
vi.mock('../turnStream', () => ({ consumeTurnStream: async (options: { onText: (text: string) => void }) => {
  if (state.fail) throw new Error('Request failed')
  if (state.stream) { options.onText(state.text); state.afterChunk() }
  return { steps: [], text: state.text }
} }))
vi.mock('./rounds', () => ({ runAgentRounds: async () => ({
  held: state.suppressed || state.stream ? '' : state.text, suppressed: state.suppressed,
  performedLines: [], interrupted: false, claimedDone: false, willVerify: false
}) }))
vi.mock('./verify', () => ({ shouldVerify: () => false }))

beforeEach(() => {
  state.settings = structuredClone(DEFAULT_SETTINGS)
  state.settings.captureScreenshotByDefault = false
  state.text = 'Ответ'
  state.suppressed = false
  state.apiKey = 'test-key'
  state.fail = false
  state.stream = false
  state.afterChunk = () => {}
})

async function harness() {
  const { createOverlayController } = await import('./index')
  let visible = false
  const send = vi.fn()
  const win = { isVisible: () => visible, isDestroyed: () => false, webContents: { send } } as unknown as BrowserWindow
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
