import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '@shared/defaults'
import type { AgentAvailability, ContextSnapshot } from '@shared/types'
import { resolveChatModel } from '../llm'
import { hasApiKey } from '../settings/secrets'
import { getSettings } from '../settings/store'
import type { Session } from './session'
import { createOverlayState, setupNotice } from './state'

vi.mock('../settings/store', () => ({ getSettings: vi.fn() }))
vi.mock('../settings/secrets', () => ({ hasApiKey: vi.fn() }))
vi.mock('../llm', () => ({ resolveChatModel: vi.fn() }))

const SNAPSHOT: ContextSnapshot = {
  activeApp: null,
  selection: null,
  screenshot: null,
  screenshotPending: false,
  excluded: false,
  warnings: ['Нет доступа к экрану', 'Нет выделения'],
  collectedMs: 42
}

const AVAILABILITY: AgentAvailability = {
  enabled: true,
  ready: false,
  reason: 'нет доступа'
}

function card(overrides: Partial<Session> = {}): Session {
  return {
    id: 's1',
    snapshot: SNAPSHOT,
    flags: { includeSelection: false, includeScreenshot: true },
    target: null,
    abort: null,
    requestId: null,
    answer: '',
    annotations: [],
    history: [],
    notices: ['Ответ без картинки'],
    ...overrides
  }
}

beforeEach(() => {
  vi.mocked(getSettings).mockReturnValue(structuredClone(DEFAULT_SETTINGS))
  vi.mocked(resolveChatModel).mockReturnValue('gpt-4o')
  vi.mocked(hasApiKey).mockReturnValue(true)
})

describe('setupNotice', () => {
  it('asks for a model when none is chosen', () => {
    vi.mocked(resolveChatModel).mockReturnValue('')

    expect(setupNotice()).toEqual({
      kind: 'warning',
      message: 'Выбери модель OpenAI в настройках.',
      target: { tab: 'provider', view: 'models' }
    })
  })

  it('asks for a key when the model is chosen', () => {
    vi.mocked(hasApiKey).mockReturnValue(false)

    expect(setupNotice()).toEqual({
      kind: 'warning',
      message: 'Добавь ключ OpenAI в настройках, чтобы получать ответы.',
      target: { tab: 'provider', view: 'connection' }
    })
  })

  it('points at the broken extra request body', () => {
    vi.mocked(getSettings).mockReturnValue({
      ...structuredClone(DEFAULT_SETTINGS),
      extraBody: { ...DEFAULT_SETTINGS.extraBody, openai: '{oops' }
    })

    expect(setupNotice()).toEqual({
      kind: 'warning',
      message: 'Доп. параметры запроса для OpenAI не разбираются — они не отправляются.',
      target: { tab: 'provider', view: 'models', focus: 'extraBody' }
    })
  })

  it('has nothing to warn about when the model and the key are ready', () => {
    expect(setupNotice()).toBeNull()
  })
})

describe('overlayState', () => {
  it('composes the card state from the session and the agent', () => {
    const session = card()
    const availability = vi.fn(() => AVAILABILITY)
    const state = createOverlayState({ current: () => session, availability })

    expect(state.overlayState()).toEqual({
      sessionId: 's1',
      context: SNAPSHOT,
      flags: session.flags,
      setupNotice: null,
      warnings: ['Нет доступа к экрану', 'Нет выделения', 'Ответ без картинки'],
      agent: AVAILABILITY
    })
    expect(availability).toHaveBeenCalledOnce()
  })

  it('has no state when no card is open', () => {
    const availability = vi.fn(() => AVAILABILITY)
    const state = createOverlayState({ current: () => null, availability })

    expect(state.overlayState()).toBeNull()
    expect(availability).not.toHaveBeenCalled()
  })
})
