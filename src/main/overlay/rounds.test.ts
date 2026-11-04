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
  const execute = vi.fn(async (): Promise<AgentRunResult> => ({
    finished: false, performed: [{ label: 'Open', ok: true }]
  }))
  const streamRound = vi.fn<RoundsDeps['streamRound']>(async () => ({ steps: [], text: 'Result' }))
  const capture = vi.fn(async () => SHOT)
  const publish = vi.fn()
  const deps: RoundsDeps = {
    get session() { return session },
    abort: new AbortController(),
    request: { requestId: 'r1', prompt: 'Open settings', mode: 'analyze', includeSelection: true, includeScreenshot: true },
    settings, area: AREA, canAct: true, canDraw: true, apiKey: 'test-key', maxTokens: 1024,
    round: { steps, text: 'Narration' }, held: 'Narration',
    agent: { execute, availability: () => ({ enabled: true, ready: false, reason: 'No permission' }) },
    publishAgent: publish, ensureFreshScreenshot: capture, streamRound
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

  it('stops after a first-round @done with no continuation', async () => {
    const h = harness([click, done])
    h.execute.mockResolvedValue({ finished: true, performed: [{ label: 'Open', ok: true }] })
    expect(await runAgentRounds(h.deps)).toMatchObject({ claimedDone: true, suppressed: true, held: '' })
    expect(h.capture).not.toHaveBeenCalled()
  })

  it('stops after an action that did not ask to look again', async () => {
    const h = harness([click])
    expect(await runAgentRounds(h.deps)).toMatchObject({ performedLines: ['Open'] })
    expect(h.execute).toHaveBeenCalledOnce()
    expect(h.capture).not.toHaveBeenCalled()
  })

  it('stops at the round budget and retains every performed step', async () => {
    const h = harness()
    h.streamRound.mockResolvedValue({ steps: [click, look], text: 'Next' })
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
})
