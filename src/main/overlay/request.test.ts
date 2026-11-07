/**
 * The request assembly is the one half of a turn that does not move the screen,
 * so it is tested without Electron — but with the real `prompt.ts` underneath:
 * a change in the prompt format must show up here, not only in the snapshots.
 */

import { describe, expect, it, vi } from 'vitest'
import type { ContextSnapshot, SendRequest } from '@shared/types'
import { buildTurnRequest, type BuildTurnRequestInput } from './request'
import { buildRefine, buildRequest } from '../prompt'
import type { AppSettings } from '@shared/types'

const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

const AREA = { x: 0, y: 0, width: 1440, height: 900 }

function snapshot(overrides: Partial<ContextSnapshot> = {}): ContextSnapshot {
  return {
    activeApp: { name: 'Safari', bundleId: 'com.apple.Safari', pid: 42, windowId: 7, bounds: AREA },
    selection: null,
    screenshot: {
      dataUrl: PNG,
      width: 1440,
      height: 900,
      bytes: 1234,
      capturedAt: 1,
      area: AREA
    },
    screenshotPending: false,
    excluded: false,
    warnings: [],
    collectedMs: 12,
    ...overrides
  } as ContextSnapshot
}

function settings(overrides: Partial<AppSettings> = {}): AppSettings {
  return {
    systemPrompt: '  Ты помощник.  ',
    maxTokens: 1024,
    provider: 'openai',
    model: 'gpt-4o',
    agent: { enabled: true, verifyResult: true },
    ...overrides
  } as unknown as AppSettings
}

function request(overrides: Partial<SendRequest> = {}): SendRequest {
  return {
    requestId: 'r1',
    prompt: 'Что это?',
    mode: 'analyze',
    includeSelection: true,
    includeScreenshot: true,
    ...overrides
  } as SendRequest
}

function input(overrides: Partial<BuildTurnRequestInput> = {}): BuildTurnRequestInput {
  const session = overrides.session ?? { snapshot: snapshot(), history: [], target: null }
  return {
    request: request(),
    session,
    settings: settings(),
    visionSupported: true,
    availability: { ready: true, reason: null },
    ensureFreshScreenshot: async () => session.snapshot.screenshot,
    describeScreen: async () => null,
    aborted: () => false,
    ...overrides
  }
}

describe('buildTurnRequest: the message list', () => {
  it('is the system message, then the history, then this question', async () => {
    const turn = await buildTurnRequest(
      input({
        session: {
          snapshot: snapshot(),
          history: [{ question: 'А это?', answer: 'Кнопка.' }],
          target: null
        }
      })
    )

    expect(turn.messages.map((message) => message.role)).toEqual([
      'system',
      'user',
      'assistant',
      'user'
    ])
    expect(turn.messages[1]?.parts[0]).toEqual({ type: 'text', text: 'А это?' })
    expect(turn.messages[2]?.parts[0]).toEqual({ type: 'text', text: 'Кнопка.' })
  })

  it('trims the system prompt and appends the mode instruction', async () => {
    const turn = await buildTurnRequest(input())

    const system = turn.messages[0]?.parts[0]
    expect(system?.type).toBe('text')
    expect((system as { text: string }).text.startsWith('Ты помощник.\n\n')).toBe(true)
  })

  it('adds the previous command as context for a new card', async () => {
    const turn = await buildTurnRequest(input({ previousCommand: 'Открой YouTube' }))

    expect(turn.messages.map(({ role }) => role)).toEqual(['system', 'user'])
    expect(turn.messages[1]?.parts.at(-1)).toEqual({
      type: 'text',
      text: expect.stringContaining('[Предыдущая просьба из другой карточки]\nОткрой YouTube\n\n[Контекст]')
    })
  })

  it('matches what prompt.ts builds for the same inputs', async () => {
    const built = buildRequest({
      prompt: 'Что это?',
      mode: 'analyze',
      snapshot: snapshot(),
      includeSelection: true,
      includeScreenshot: true,
      hasImage: true,
      draw: true,
      act: false,
      actReason: null,
      hasHistory: false,
      outline: null
    })
    const turn = await buildTurnRequest(
      input({ availability: { ready: false, reason: null } })
    )

    expect(turn.messages.at(-1)?.parts.at(-1)).toEqual({
      type: 'text',
      text: built.userText
    })
  })

  it('puts the image before the text, and only when there is one', async () => {
    const withImage = await buildTurnRequest(input())
    const withoutImage = await buildTurnRequest(
      input({ request: request({ includeScreenshot: false }) })
    )

    expect(withImage.messages.at(-1)?.parts.map((part) => part.type)).toEqual([
      'image',
      'text'
    ])
    expect(withoutImage.messages.at(-1)?.parts.map((part) => part.type)).toEqual(['text'])
  })
})

describe('buildTurnRequest: refine', () => {
  const refine = { direction: 'shorter' as const, baseAnswer: '  Длинный ответ.  ' }

  it('sends no history and no image', async () => {
    const turn = await buildTurnRequest(
      input({
        request: request({ refine }),
        session: {
          snapshot: snapshot(),
          history: [{ question: 'старый', answer: 'ответ' }],
          target: null
        }
      })
    )

    expect(turn.messages.map((message) => message.role)).toEqual(['system', 'user'])
    expect(turn.useImage).toBe(false)
    expect(turn.canDraw).toBe(false)
    expect(turn.canAct).toBe(false)
  })

  it('uses the refine prompt with the trimmed base answer', async () => {
    const expected = buildRefine({
      direction: 'shorter',
      baseAnswer: 'Длинный ответ.',
      mode: 'analyze',
      originalPrompt: 'Что это?'
    })
    const turn = await buildTurnRequest(input({ request: request({ refine }) }))

    expect(turn.messages.at(-1)?.parts.at(-1)).toEqual({
      type: 'text',
      text: expected.userText
    })
  })

  it('raises the token ceiling for «длиннее», bounded', async () => {
    const longer = await buildTurnRequest(
      input({
        request: request({ refine: { direction: 'longer', baseAnswer: 'ответ' } }),
        settings: settings({ maxTokens: 1024 })
      })
    )
    const capped = await buildTurnRequest(
      input({
        request: request({ refine: { direction: 'longer', baseAnswer: 'ответ' } }),
        settings: settings({ maxTokens: 4000 })
      })
    )

    expect(longer.maxTokens).toBe(2048)
    expect(capped.maxTokens).toBe(4096)
  })

  it('keeps the plain ceiling for a normal question', async () => {
    const turn = await buildTurnRequest(input())

    expect(turn.maxTokens).toBe(1024)
  })
})

describe('buildTurnRequest: tools are a capability', () => {
  it('offers neither tool without an image', async () => {
    const turn = await buildTurnRequest(
      input({ request: request({ includeScreenshot: false }) })
    )

    expect(turn.canDraw).toBe(false)
    expect(turn.canAct).toBe(false)
    // The rectangle is still reported: it is the frame of the snapshot, and the
    // callers use it for the plan budget. What gates the tools is `canDraw`.
    expect(turn.area).toEqual(AREA)
  })

  it('offers neither tool when the model cannot see', async () => {
    const turn = await buildTurnRequest(input({ visionSupported: false }))

    expect(turn.useImage).toBe(false)
    expect(turn.canDraw).toBe(false)
    expect(turn.canAct).toBe(false)
  })

  it('offers drawing but not acting when acting is unavailable', async () => {
    const turn = await buildTurnRequest(
      input({ availability: { ready: false, reason: 'нет доступа' } })
    )

    expect(turn.canDraw).toBe(true)
    expect(turn.canAct).toBe(false)
    expect(turn.area).toEqual(AREA)
  })

  it('mentions the reason only when there is an image to draw on', async () => {
    const withImage = await buildTurnRequest(
      input({ availability: { ready: false, reason: 'нет доступа' } })
    )
    const noImage = await buildTurnRequest(
      input({
        request: request({ includeScreenshot: false }),
        availability: { ready: false, reason: 'нет доступа' }
      })
    )

    // The note lives in the system message: it qualifies the tool, it is not part
    // of the question.
    const instructionOf = (turn: typeof withImage): string =>
      (turn.messages[0]?.parts[0] as { text: string }).text

    expect(instructionOf(withImage)).toContain('нет доступа')
    expect(instructionOf(noImage)).not.toContain('нет доступа')
  })

  it('holds the prose only for a spoken turn that can act', async () => {
    const spoken = await buildTurnRequest(input({ request: request({ voice: true }) }))
    const typed = await buildTurnRequest(input())
    const spokenWithoutActing = await buildTurnRequest(
      input({
        request: request({ voice: true }),
        availability: { ready: false, reason: null }
      })
    )

    expect(spoken.holdFirstRound).toBe(true)
    expect(typed.holdFirstRound).toBe(false)
    expect(spokenWithoutActing.holdFirstRound).toBe(false)
  })
})

describe('buildTurnRequest: the two awaits', () => {
  it('asks for a fresh screenshot only when an image is going out', async () => {
    const ensure = vi.fn(async () => null)
    await buildTurnRequest(input({ ensureFreshScreenshot: ensure }))
    await buildTurnRequest(
      input({ ensureFreshScreenshot: ensure, request: request({ includeScreenshot: false }) })
    )
    await buildTurnRequest(input({ ensureFreshScreenshot: ensure, visionSupported: false }))

    expect(ensure).toHaveBeenCalledTimes(1)
  })

  it('binds coordinates to the returned frame even when the preview changes', async () => {
    const deps = input()
    const frame = deps.session.snapshot.screenshot!
    deps.ensureFreshScreenshot = async () => {
      deps.session.snapshot.screenshot = { ...frame, area: { ...AREA, x: AREA.x + 400 } }
      return frame
    }
    const turn = await buildTurnRequest(deps)
    expect(turn.screenshot).toBe(frame)
    expect(turn.area).toEqual(AREA)
  })

  it('reports the turn as abandoned when the abort fired during the capture', async () => {
    let aborted = false
    const turn = await buildTurnRequest(
      input({
        ensureFreshScreenshot: async () => {
          aborted = true
          return null
        },
        aborted: () => aborted
      })
    )

    expect(turn.abandoned).toBe(true)
    expect(turn.messages).toEqual([])
  })

  it('asks for the outline for drawing even when acting is unavailable', async () => {
    const describe = vi.fn(async () => 'кнопка «ОК»')
    const acting = await buildTurnRequest(
      input({
        session: { snapshot: snapshot(), history: [], target: snapshot().activeApp },
        describeScreen: describe
      })
    )
    await buildTurnRequest(
      input({
        session: { snapshot: snapshot(), history: [], target: snapshot().activeApp },
        describeScreen: describe,
        availability: { ready: false, reason: null }
      })
    )

    expect(describe).toHaveBeenCalledTimes(2)
    expect(describe).toHaveBeenCalledWith(42, AREA, AREA)
    expect(acting.canAct).toBe(true)
  })

  it('survives a failing outline: the request goes out without the names', async () => {
    const turn = await buildTurnRequest(
      input({
        session: { snapshot: snapshot(), history: [], target: snapshot().activeApp },
        describeScreen: async () => {
          throw new Error('helper упал')
        }
      })
    )

    expect(turn.abandoned).toBe(false)
    expect(turn.messages).toHaveLength(2)
  })
})
