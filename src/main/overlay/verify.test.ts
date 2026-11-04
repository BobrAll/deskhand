/**
 * The verification round, driven with fakes: a scripted model, a fake screen and
 * a fake runner. What is pinned is the *decision* — confirmed, unconfirmed, not
 * run — and the sequence of side effects that leads to it, because the failure
 * this module exists to prevent is a confident «Готово» nobody saw.
 */

import { describe, expect, it } from 'vitest'
import type { AgentPlanStep, AppSettings, ScreenshotInfo } from '@shared/types'
import { MAX_CHECKS, VERIFY_SETTLE_MS, shouldVerify, verifyResult, type VerifyDeps } from './verify'
import { buildVerify } from '../prompt'

const AREA = { x: 0, y: 0, width: 1440, height: 900 }
const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

const SHOT: ScreenshotInfo = {
  dataUrl: PNG,
  width: 1440,
  height: 900,
  bytes: 1234,
  capturedAt: 1,
  fullScreen: true,
  area: AREA
}

const settings = {
  systemPrompt: '  Ты помощник.  ',
  maxTokens: 1024,
  agent: { enabled: true, verifyResult: true, maxSteps: 6 }
} as unknown as AppSettings

/** The `@done` marker: a claim, no coordinates to act on. */
function doneStep(): AgentPlanStep {
  return { action: { kind: 'done' }, label: 'готово' }
}

/** A step that asks for a click — the shape `readVerdict` turns into `actions`. */
function clickStep(): AgentPlanStep {
  return {
    action: { kind: 'click', at: { x: 0.5, y: 0.5 }, button: 'left', label: 'Применить' },
    label: 'нажать «Применить»'
  }
}

interface Harness {
  deps: VerifyDeps
  events: string[]
  rounds: Array<{ canDraw: boolean; holdText: boolean; messages: unknown }>
  executed: Array<{ steps: AgentPlanStep[]; skipped: string[] }>
  delays: number[]
}

function harness(overrides: Partial<VerifyDeps> = {}): Harness {
  // `rounds` and `executed` are filled by the default fakes; an override that
  // replaces one of them still gets counted through these wrappers.
  const events: string[] = []
  const rounds: Harness['rounds'] = []
  const executed: Harness['executed'] = []
  const delays: number[] = []

  const defaults: VerifyDeps = {
    settings,
    requestId: 'r1',
    prompt: 'Открой настройки',
    apiKey: 'test-key',
    maxTokens: 1024,
    performedLines: ['нажал «Настройки»'],
    signal: new AbortController().signal,
    isAlive: () => true,
    publishAgent: (event) => events.push(`${event.phase}:${event.label}`),
    capture: async () => SHOT,
    streamRound: async () => ({ steps: [doneStep()], text: 'похоже, всё открыто' }),
    execute: async () => ({
      finished: true,
      performed: [{ ok: true, label: 'нажал «Применить»' }]
    }),
    lastPhase: () => 'done',
    delay: async (ms) => {
      delays.push(ms)
    },
  }

  const deps: VerifyDeps = {
    ...defaults,
    ...overrides,
    streamRound: async (options) => {
      const result = await (overrides.streamRound ?? defaults.streamRound)(options)
      rounds.push({
        canDraw: options.canDraw,
        holdText: options.holdText,
        messages: options.messages
      })
      return result
    },
    execute: async (options) => {
      const result = await (overrides.execute ?? defaults.execute)(options)
      executed.push({ steps: options.steps, skipped: options.skipped ?? [] })
      return result
    }
  }

  return { deps, events, rounds, executed, delays }
}

describe('shouldVerify: when a check is worth spending', () => {
  const base = { willVerify: true, interrupted: false, performed: 1, claimedDone: false }

  it('checks a turn that actually did something', () => {
    expect(shouldVerify(base)).toBe(true)
  })

  it('checks a turn that only claimed it was done', () => {
    expect(shouldVerify({ ...base, performed: 0, claimedDone: true })).toBe(true)
  })

  it('skips a text-only answer: there is no claim about the screen', () => {
    expect(shouldVerify({ ...base, performed: 0, claimedDone: false })).toBe(false)
  })

  it('skips a turn the runner was not told to withhold «Готово» for', () => {
    expect(shouldVerify({ ...base, willVerify: false })).toBe(false)
  })

  it('skips a turn the user interrupted', () => {
    expect(shouldVerify({ ...base, interrupted: true })).toBe(false)
  })
})

describe('verifyResult: a confirmed claim', () => {
  it('confirms after exactly one look', async () => {
    const { deps } = harness()

    expect(await verifyResult(deps)).toEqual({
      outcome: 'confirmed',
      evidence: 'похоже, всё открыто'
    })
    expect(deps.performedLines).toEqual(['нажал «Настройки»'])
  })

  it('waits for the screen to settle before photographing it', async () => {
    const { deps, delays } = harness()
    await verifyResult(deps)

    expect(delays).toEqual([VERIFY_SETTLE_MS])
  })

  it('asks with a held verdict, no drawing tool, and the image first', async () => {
    const { deps, rounds } = harness()
    await verifyResult(deps)

    const expected = buildVerify({
      performed: ['нажал «Настройки»'],
      prompt: 'Открой настройки',
      canFix: true
    })
    const messages = rounds[0]?.messages as Array<{
      role: string
      parts: Array<{ type: string; text?: string }>
    }>

    expect(rounds[0]?.holdText).toBe(true)
    expect(rounds[0]?.canDraw).toBe(false)
    expect(messages[0]?.parts[0]?.text).toBe(`Ты помощник.\n\n${expected.modeInstruction}`)
    expect(messages[1]?.parts.map((part) => part.type)).toEqual(['image', 'text'])
    expect(messages[1]?.parts.at(-1)?.text).toBe(expected.userText)
  })

  it('executes nothing when the screen agrees', async () => {
    const { deps, executed } = harness()
    await verifyResult(deps)

    expect(executed).toEqual([])
  })
})

describe('verifyResult: an unconfirmed claim', () => {
  it('reports the evidence instead of a status word', async () => {
    const { deps } = harness({
      streamRound: async () => ({ steps: [], text: 'настройки не открылись' })
    })

    expect(await verifyResult(deps)).toEqual({
      outcome: 'unconfirmed',
      evidence: 'настройки не открылись'
    })
  })

  it('runs one correction and looks again', async () => {
    let round = 0
    const { deps, executed, delays } = harness({
      streamRound: async () => {
        round += 1
        return round === 1
          ? { steps: [clickStep()], text: 'попробую ещё раз' }
          : { steps: [doneStep()], text: 'теперь открыто' }
      }
    })

    expect((await verifyResult(deps)).outcome).toBe('confirmed')
    expect(executed).toHaveLength(1)
    expect(executed[0]?.steps).toHaveLength(1)
    expect(delays).toHaveLength(2)
  })

  it('never lets the last check act, and never spends a third round', async () => {
    const { deps, executed, rounds } = harness({
      streamRound: async () => ({ steps: [clickStep()], text: 'всё ещё нет' })
    })

    expect((await verifyResult(deps)).outcome).toBe('unconfirmed')
    expect(rounds).toHaveLength(MAX_CHECKS)
    expect(executed).toHaveLength(MAX_CHECKS - 1)
  })

  it('adds what the correction did to the list the next check is given', async () => {
    const { deps } = harness({
      streamRound: async () => ({ steps: [clickStep()], text: 'пробую' })
    })

    await verifyResult(deps)

    // One correction runs: the second look has no budget to act, so it reports.
    expect(deps.performedLines).toEqual(['нажал «Настройки»', 'нажал «Применить»'])
  })

  it('marks a step that failed instead of counting it as done', async () => {
    const { deps } = harness({
      streamRound: async () => ({ steps: [clickStep()], text: 'пробую' }),
      execute: async () => ({
        finished: false,
        performed: [{ ok: false, label: 'нажал «Применить»' }]
      })
    })

    await verifyResult(deps)

    expect(deps.performedLines[1]).toBe('нажал «Применить» (не удалось)')
  })

  it('stops checking when the correction itself broke off', async () => {
    const { deps, rounds } = harness({
      streamRound: async () => ({ steps: [clickStep()], text: 'пробую' }),
      execute: async () => ({ finished: false, performed: [], message: 'не нашёл кнопку' })
    })

    expect(await verifyResult(deps)).toEqual({ outcome: 'unconfirmed', evidence: 'пробую' })
    expect(rounds).toHaveLength(1)
  })

  it('does not blame the result for a correction the user stopped', async () => {
    const { deps } = harness({
      streamRound: async () => ({ steps: [clickStep()], text: 'пробую' }),
      execute: async () => ({ finished: false, performed: [], message: 'остановлено' }),
      lastPhase: () => 'aborted'
    })

    expect((await verifyResult(deps)).outcome).toBe('not-run')
  })
})

describe('verifyResult: a check that never ran', () => {
  it('is not a verdict when the screen could not be photographed', async () => {
    const { deps, events, rounds } = harness({ capture: async () => null })

    expect((await verifyResult(deps)).outcome).toBe('not-run')
    expect(rounds).toHaveLength(0)
    expect(events).toContain('error:')
  })

  it('is not a verdict when there is no key', async () => {
    const { deps, rounds } = harness({ apiKey: '' })

    expect((await verifyResult(deps)).outcome).toBe('not-run')
    expect(rounds).toHaveLength(0)
  })

  it('says the check was stopped when the turn was aborted under it', async () => {
    const abort = new AbortController()
    const { deps, events } = harness({
      signal: abort.signal,
      delay: async () => {
        abort.abort()
      }
    })

    expect((await verifyResult(deps)).outcome).toBe('not-run')
    expect(events).toContain('aborted:')
  })

  it('stops after the screenshot when the turn was cancelled meanwhile', async () => {
    const abort = new AbortController()
    const { deps, rounds } = harness({
      signal: abort.signal,
      capture: async () => {
        abort.abort()
        return SHOT
      }
    })

    expect((await verifyResult(deps)).outcome).toBe('not-run')
    expect(rounds).toHaveLength(0)
  })
})
