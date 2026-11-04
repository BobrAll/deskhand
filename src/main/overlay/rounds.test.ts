import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '@shared/defaults'
import type { AgentPlanStep, ScreenshotInfo } from '@shared/types'
import type { AgentRunResult } from '../agent'
import { buildContinue } from '../prompt'
import { runAgentRounds, type RoundsDeps, type RoundSession } from './rounds'

const AREA = { x: 0, y: 0, width: 1440, height: 900 }
const SHOT: ScreenshotInfo = {
  dataUrl: 'data:image/png;base64,abc', width: 1440, height: 900,
  bytes: 3, capturedAt: 1, fullScreen: true, area: AREA
}
const click: AgentPlanStep = {
  action: { kind: 'click', at: { x: 0.5, y: 0.5 }, button: 'left', label: 'Open' }, label: 'Open'
}
const look: AgentPlanStep = { action: { kind: 'look' }, label: 'Look' }
const done: AgentPlanStep = { action: { kind: 'done' }, label: 'Done' }

function harness(steps = [click, look]) {
  const settings = structuredClone(DEFAULT_SETTINGS)
  settings.agent.enabled = true
  settings.agent.verifyResult = true
  settings.agent.maxSteps = 3
  settings.systemPrompt = '  System  '
  let session: RoundSession | null = { rounds: 0, snapshot: { screenshot: SHOT } }
  const execute = vi.fn<RoundsDeps['agent']['execute']>(async (): Promise<AgentRunResult> => ({
    finished: false, performed: [{ label: 'Open', ok: true }]
  }))
  const streamRound = vi.fn<RoundsDeps['streamRound']>(async () => ({ steps: [], text: 'Result' }))
  const capture = vi.fn<RoundsDeps['capture']>(async () => SHOT)
  const publish = vi.fn()
  const deps: RoundsDeps = {
    get session() { return session },
    abort: new AbortController(),
    request: { requestId: 'r1', prompt: 'Open settings', mode: 'analyze', includeSelection: true, includeScreenshot: true },
    settings, area: AREA, canAct: true, canDraw: true, apiKey: 'test-key', maxTokens: 1024,
    round: { steps, text: 'Narration' }, held: 'Narration',
    agent: { execute, availability: () => ({ enabled: true, ready: false, reason: 'No permission' }) },
    publishAgent: publish, capture, streamRound
  }
  return { deps, execute, streamRound, capture, publish, close: () => { session = null } }
}

describe('agent rounds', () => {
  it('returns a text-only answer without executing or capturing', async () => {
    const h = harness([])
    expect(await runAgentRounds(h.deps)).toMatchObject({ held: 'Narration', suppressed: false, performedLines: [] })
    expect(h.execute).not.toHaveBeenCalled()
    expect(h.capture).not.toHaveBeenCalled()
  })

  it('observes again when @done came with unobserved actions', async () => {
    const h = harness([click, done])
    h.execute.mockResolvedValue({ finished: true, performed: [{ label: 'Open', ok: true }] })
    expect(await runAgentRounds(h.deps)).toMatchObject({ claimedDone: false, suppressed: true })
    expect(h.capture).toHaveBeenCalledOnce()
  })

  it('observes after actions even if the model omitted @look', async () => {
    const h = harness([click])
    expect(await runAgentRounds(h.deps)).toMatchObject({ performedLines: ['Open'] })
    expect(h.execute).toHaveBeenCalledOnce()
    expect(h.capture).toHaveBeenCalledOnce()
  })

  it('stops at the round budget and retains every performed step', async () => {
    const h = harness()
    h.streamRound.mockResolvedValue({ steps: [click, look], text: 'Next' })
    let frame = 0
    h.capture.mockImplementation(async () => ({ ...SHOT, dataUrl: `data:image/png;base64,frame${++frame}` }))
    expect(await runAgentRounds(h.deps)).toMatchObject({ performedLines: ['Open', 'Open', 'Open'], held: '', suppressed: true })
    expect(h.execute).toHaveBeenCalledTimes(3)
    expect(h.streamRound).toHaveBeenCalledTimes(2)
    expect(h.deps.session?.rounds).toBe(3)
  })

  it('does not request a continuation when maxSteps is one', async () => {
    const h = harness()
    h.deps.settings.agent.maxSteps = 1
    await runAgentRounds(h.deps)
    expect(h.execute).toHaveBeenCalledOnce()
    expect(h.capture).not.toHaveBeenCalled()
  })

  it('passes the exact continuation messages and verification policy', async () => {
    const h = harness()
    await runAgentRounds(h.deps)
    const prompt = buildContinue({ performed: ['Open'], prompt: 'Open settings', round: 1, canContinue: true, act: true })
    expect(h.execute.mock.calls[0]).toEqual([expect.objectContaining({ verify: true, area: AREA })])
    expect(h.streamRound).toHaveBeenCalledWith(expect.objectContaining({
      holdText: true, signal: h.deps.abort.signal, requestId: 'r1', area: AREA,
      messages: [
        { role: 'system', parts: [{ type: 'text', text: `System\n\n${prompt.modeInstruction}` }] },
        { role: 'user', parts: [{ type: 'image', mimeType: 'image/png', base64: 'abc' }, { type: 'text', text: prompt.userText }] }
      ]
    }))
  })

  it.each(['execute', 'capture', 'stream'] as const)('checks abort after %s', async (stage) => {
    const h = harness()
    if (stage === 'execute') h.execute.mockImplementation(async () => {
      h.deps.abort.abort()
      return { finished: false, performed: [] }
    })
    if (stage === 'capture') h.capture.mockImplementation(async () => {
      h.deps.abort.abort()
      return SHOT
    })
    if (stage === 'stream') h.streamRound.mockImplementation(async () => {
      h.deps.abort.abort()
      return { steps: [click], text: 'Next' }
    })
    expect(await runAgentRounds(h.deps)).toBeNull()
    expect(h.execute).toHaveBeenCalledOnce()
    if (stage !== 'stream') expect(h.streamRound).not.toHaveBeenCalled()
  })

  it('reads the live session after capture and stops if it was closed', async () => {
    const h = harness()
    h.capture.mockImplementation(async () => { h.close(); return SHOT })
    expect(await runAgentRounds(h.deps)).toBeNull()
    expect(h.streamRound).not.toHaveBeenCalled()
  })

  it('reports unavailable actions without executing', async () => {
    const h = harness()
    h.deps.canAct = false
    await runAgentRounds(h.deps)
    expect(h.publish).toHaveBeenCalledWith(expect.objectContaining({ phase: 'error', message: 'No permission' }))
    expect(h.execute).not.toHaveBeenCalled()
  })

  it('records failed steps and interruptions before stopping', async () => {
    const h = harness()
    h.execute.mockResolvedValue({ finished: false, message: 'Stopped', performed: [{ label: 'Open', ok: false }] })
    expect(await runAgentRounds(h.deps)).toMatchObject({ interrupted: true, performedLines: ['Open (не удалось)'] })
    expect(h.capture).not.toHaveBeenCalled()
  })

  it('does not take the mouse back when an action produced no steps', async () => {
    const h = harness()
    h.execute.mockResolvedValue({ finished: false, performed: [] })
    await runAgentRounds(h.deps)
    expect(h.capture).not.toHaveBeenCalled()
  })

  it('allows a look-only continuation without executing a plan', async () => {
    const h = harness([look])
    expect(await runAgentRounds(h.deps)).toMatchObject({ held: 'NarrationResult', suppressed: false })
    expect(h.execute).not.toHaveBeenCalled()
    expect(h.capture).toHaveBeenCalledOnce()
  })

  it('keeps every stage of the task in the next prompt and permits the last budgeted action', async () => {
    const h = harness()
    const search = { ...click, label: 'Search cats', action: { kind: 'type' as const, text: 'cats' } }
    const play = { ...click, label: 'Play', action: { ...click.action, label: 'Play' } }
    h.deps.request.prompt = 'Открой YouTube, найди видео с котами и запусти'
    h.streamRound.mockResolvedValueOnce({ steps: [search], text: '' })
      .mockResolvedValueOnce({ steps: [play], text: '' })
    h.execute.mockImplementation(async (request) => ({
      finished: false, performed: request.steps.map((step) => ({ label: step.label, ok: true }))
    }))
    await runAgentRounds(h.deps)
    expect(h.execute).toHaveBeenCalledTimes(3)
    const finalRequest = h.streamRound.mock.calls[1][0]
    const messages = JSON.stringify(finalRequest.messages)
    expect(messages).toContain('• Open')
    expect(messages).toContain('• Search cats')
    expect(messages).toContain(h.deps.request.prompt)
    expect(messages).toContain('@click')
    expect(messages).not.toContain('лимит шагов исчерпан')
  })

  it.each([
    ['Открой YouTube, найди видео с котами и запусти', ['YouTube', 'Результаты поиска', 'Видео', 'Пауза']],
    ['Открой презентацию на рабочем столе', ['Рабочий стол', 'Презентация.pptx', 'Слайды']]
  ])('continues through intermediate claimed successes: %s', async (prompt, stages) => {
    const action = (label: string): AgentPlanStep => ({
      label, action: { kind: 'click', at: { x: 0.5, y: 0.5 }, button: 'double', label }
    })
    const h = harness([action(stages[0]), done])
    h.deps.settings.agent.maxSteps = 8
    h.deps.request.prompt = prompt
    for (const stage of stages.slice(1)) {
      h.streamRound.mockResolvedValueOnce({ steps: [action(stage), done], text: 'Готово' })
    }
    h.streamRound.mockResolvedValueOnce({ steps: [done], text: 'Результат виден' })
    h.execute.mockImplementation(async (request) => ({
      finished: true,
      performed: request.steps.filter((step) => step.action.kind !== 'done')
        .map((step) => ({ label: step.label, ok: true }))
    }))
    const result = await runAgentRounds(h.deps)
    expect(result?.performedLines).toEqual(stages)
    expect(result?.claimedDone).toBe(true)
    expect(h.capture).toHaveBeenCalledTimes(stages.length)
  })

  it('uses the returned fresh frame and its area, even when the session still holds the old one', async () => {
    const h = harness()
    const freshArea = { x: 1440, y: -200, width: 1920, height: 1080 }
    h.capture.mockResolvedValue({ ...SHOT, area: freshArea, dataUrl: 'data:image/png;base64,new' })
    h.streamRound.mockResolvedValueOnce({ steps: [click], text: '' })
    await runAgentRounds(h.deps)
    expect(h.execute.mock.calls[1][0].area).toEqual(freshArea)
    expect(JSON.stringify(h.streamRound.mock.calls[0][0].messages)).toContain('"base64":"new"')
  })

  it.each([null, { ...SHOT, area: null }, { ...SHOT, dataUrl: 'broken' }])(
    'stops instead of reusing an old screenshot when capture is unusable', async (shot) => {
      const h = harness()
      h.capture.mockResolvedValue(shot)
      expect(await runAgentRounds(h.deps)).toMatchObject({ interrupted: true })
      expect(h.streamRound).not.toHaveBeenCalled()
      expect(h.execute).toHaveBeenCalledOnce()
    }
  )

  it('blocks a repeated plan, asks for a different approach and runs that approach', async () => {
    const h = harness()
    h.deps.settings.agent.maxSteps = 4
    const alternative: AgentPlanStep = { action: { kind: 'key', combo: 'enter' }, label: 'Enter' }
    h.streamRound.mockResolvedValueOnce({ steps: [click], text: '' })
      .mockResolvedValueOnce({ steps: [alternative], text: '' })
      .mockResolvedValueOnce({ steps: [done], text: '' })
    h.execute.mockImplementation(async (request) => ({
      finished: request.steps[0].action.kind === 'done',
      performed: request.steps[0].action.kind === 'done' ? [] : [{ label: request.steps[0].label, ok: true }]
    }))
    const result = await runAgentRounds(h.deps)
    expect(result?.performedLines).toEqual(['Open', 'Enter'])
    expect(result?.claimedDone).toBe(true)
    expect(h.execute).toHaveBeenCalledTimes(3)
    expect(JSON.stringify(h.streamRound.mock.calls[1][0].messages)).toContain('Повтор не выполнен')
  })

  it('stops persistent repetition without clicking again', async () => {
    const h = harness()
    h.streamRound.mockResolvedValue({ steps: [click], text: '' })
    expect(await runAgentRounds(h.deps)).toMatchObject({ interrupted: true, claimedDone: false })
    expect(h.execute).toHaveBeenCalledOnce()
    expect(h.publish).toHaveBeenLastCalledWith(expect.objectContaining({ phase: 'error' }))
  })

  it('replans a known target failure with the failure and current AX names', async () => {
    const h = harness()
    h.execute.mockResolvedValueOnce({ finished: false, performed: [],
      message: 'Поле не в фокусе', recoverable: true })
    h.deps.describeScreen = vi.fn(async () => '0.4 0.2 поле «Search»')
    await runAgentRounds(h.deps)
    expect(h.capture).toHaveBeenCalledOnce()
    const messages = JSON.stringify(h.streamRound.mock.calls[0][0].messages)
    expect(messages).toContain('Поле не в фокусе')
    expect(messages).toContain('поле «Search»')
    expect(h.streamRound.mock.calls[0][0].canDraw).toBe(false)
  })

  it('does not execute a dependent Enter when typing was rejected', async () => {
    const h = harness([
      { action: { kind: 'type', text: 'cats' }, label: 'Search' },
      { action: { kind: 'key', combo: 'enter' }, label: 'Submit' }, done
    ])
    h.deps.settings.agent.allowTyping = false
    expect(await runAgentRounds(h.deps)).toMatchObject({ interrupted: true, claimedDone: false })
    expect(h.execute).not.toHaveBeenCalled()
  })

  it('reports exhausted budget when verification is disabled', async () => {
    const h = harness()
    h.deps.settings.agent.maxSteps = 1
    h.deps.settings.agent.verifyResult = false
    expect(await runAgentRounds(h.deps)).toMatchObject({ interrupted: true, claimedDone: false })
    expect(h.publish).toHaveBeenLastCalledWith(expect.objectContaining({ phase: 'error', message: expect.stringContaining('Лимит') }))
  })

  it('does not leave a checking indicator hanging after a text-only stop without verification', async () => {
    const h = harness()
    h.deps.settings.agent.verifyResult = false
    h.streamRound.mockResolvedValue({ steps: [], text: 'Нужно выбрать одну из двух презентаций.' })
    expect(await runAgentRounds(h.deps)).toMatchObject({ interrupted: true })
    expect(h.publish).toHaveBeenLastCalledWith(expect.objectContaining({
      phase: 'error', message: 'Нужно выбрать одну из двух презентаций.'
    }))
  })

  it('does not announce unobserved success even when final verification is disabled', async () => {
    const h = harness([click, done])
    h.deps.settings.agent.verifyResult = false
    await runAgentRounds(h.deps)
    expect(h.execute.mock.calls[0][0].verify).toBe(true)
  })
})
