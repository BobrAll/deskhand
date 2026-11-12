/**
 * The agent controller: the three questions it answers for the card.
 *
 * Whether the run may start at all, whether it may do *this one thing*, and how
 * to stop it. Everything else — coordinates, element indices, batching, checking
 * its own clicks — belongs to the Swift agent and is deliberately not tested
 * here: re-asserting it in TypeScript would only prove that a mock agrees with
 * itself.
 *
 * The sidecar is faked at its own seam (a stream of `AgentSidecarEvent`s), so
 * what these tests pin down is the mapping from the agent's events to what the
 * user sees, and the handshake that a blocked run depends on.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AGENT_MIN_OUTPUT_TOKENS } from '@shared/defaults'
import type { AgentEvent, AgentPresentation, AgentToolRequest } from '@shared/types'

const state = vi.hoisted(() => ({
  enabled: true,
  binary: '/tmp/deskhand-agent' as string | null,
  helper: '/tmp/helper' as string | null,
  trusted: true,
  remembered: [] as string[],
  maxSteps: 8,
  abortOnMouseMove: true,
  verifyResult: true,
  showActions: true,
  /** Events the controller will receive, pushed by each test. */
  emit: (_event: unknown) => {},
  runRejects: null as Error | null,
  approvals: [] as { id: string; allow: boolean; reason?: string }[],
  cancels: 0,
  runs: [] as unknown[],
  /** Everything the controller asked the trace to record. */
  traceEvents: [] as Record<string, unknown>[]
}))

vi.mock('./trace', () => ({
  trace: (event: string, fields: Record<string, unknown> = {}) => {
    state.traceEvents.push({ event, ...fields })
  },
  // The controller runs inside a turn of its own when the caller did not open
  // one; in these tests the turn is irrelevant, so it just runs the work.
  traceWithin: (_fields: unknown, work: () => Promise<unknown>) => work()
}))
vi.mock('electron', () => ({
  systemPreferences: { isTrustedAccessibilityClient: () => state.trusted },
  app: { getPath: () => '/tmp', getVersion: () => '0.0.0' }
}))
vi.mock('../native/helper', () => ({
  helperBinary: () => state.helper,
  watchForAbort: () => ({ stop: vi.fn() })
}))
vi.mock('../settings/store', () => ({
  getSettings: () => ({
    agent: {
      enabled: state.enabled,
      maxSteps: state.maxSteps,
      abortOnMouseMove: state.abortOnMouseMove,
      verifyResult: state.verifyResult,
      showActions: state.showActions,
      rememberedApprovals: state.remembered
    }
  }),
  patchSettings: (patch: { agent: { rememberedApprovals: string[] } }) => {
    state.remembered = patch.agent.rememberedApprovals
  }
}))
vi.mock('./sidecar', () => ({
  agentBinary: () => state.binary,
  AgentSidecar: class {
    onEvent(handler: (event: unknown) => void) {
      state.emit = handler
      return () => {
        state.emit = () => {}
      }
    }
    async run(options: unknown) {
      state.runs.push(options)
      if (state.runRejects) throw state.runRejects
    }
    approve(id: string, allow: boolean, reason?: string) {
      state.approvals.push({ id, allow, ...(reason ? { reason } : {}) })
    }
    cancel() {
      state.cancels += 1
    }
    dispose() {}
  }
}))

const { createAgentController } = await import('./index')

/** A confirmation request, with the shape the agent really sends. */
function call(overrides: Partial<AgentToolRequest> = {}): AgentToolRequest {
  return {
    id: 'call-1',
    tool: 'click',
    arguments: {},
    fingerprint: 'a'.repeat(64),
    app: 'Safari',
    title: 'Купить',
    ...overrides
  }
}

const PROVIDER = {
  wire: 'openai' as const, baseUrl: 'https://example.test', model: 'm',
  apiKey: 'k', maxTokens: 1024, temperature: 0
}

function harness(options: { maxTokens?: number } = {}) {
  const events: AgentEvent[] = []
  const passthrough: boolean[] = []
  const presentations: AgentPresentation[] = []
  const controller = createAgentController({
    emit: (event) => events.push(event),
    setPassthrough: (active) => passthrough.push(active),
    present: (action) => presentations.push(action)
  })
  return {
    controller,
    events,
    passthrough,
    presentations,
    /** The last thing the card was told. */
    last: () => events.at(-1)!,
    /** Everything this run asked the trace to record. */
    trace: () => state.traceEvents.filter((line) => line.event !== 'agent.start'),
    run: (prompt = 'Нажми «Купить»', history?: { question: string; answer: string }[]) => controller.run({
      prompt,
      appName: 'Safari',
      windowTitle: 'Магазин',
      ...(history ? { history } : {}),
      provider: { ...PROVIDER, ...(options.maxTokens ? { maxTokens: options.maxTokens } : {}) }
    })
  }
}

beforeEach(() => {
  state.enabled = true
  state.binary = '/tmp/deskhand-agent'
  state.helper = '/tmp/helper'
  state.trusted = true
  state.remembered = []
  state.maxSteps = 8
  state.abortOnMouseMove = true
  state.verifyResult = true
  state.showActions = true
  state.emit = () => {}
  state.runRejects = null
  state.approvals = []
  state.cancels = 0
  state.runs = []
  state.traceEvents = []
})

describe('availability: three separate reasons, three separate fixes', () => {
  it('names the switch when the mode is off', () => {
    state.enabled = false
    const { controller } = harness()

    expect(controller.availability()).toEqual({
      enabled: false, ready: false, reason: 'Агентный режим выключен в настройках.'
    })
  })

  it('names the build when the binary is missing', () => {
    state.binary = null
    const { controller } = harness()

    expect(controller.availability().reason).toContain('npm run build:agent')
    expect(controller.availability().needsAccessibility).toBeUndefined()
  })

  it('names the grant when Accessibility was never given', () => {
    state.trusted = false
    const { controller } = harness()

    expect(controller.availability()).toMatchObject({
      enabled: true, ready: false, needsAccessibility: true
    })
    expect(controller.availability().reason).toContain('Универсальный доступ')
  })

  it('is ready when all three agree', () => {
    expect(harness().controller.availability()).toEqual({ enabled: true, ready: true, reason: null })
  })
})

describe('a run that is blocked', () => {
  it('refuses without starting the agent, and says why', async () => {
    state.enabled = false
    const h = harness()

    const result = await h.run()

    expect(result.blocked).toBe(true)
    expect(result.message).toBe('Агентный режим выключен в настройках.')
    expect(state.runs).toHaveLength(0)
    expect(h.last().phase).toBe('error')
  })

  it('does not make the card click-through for a run that never starts', async () => {
    state.trusted = false
    const h = harness()

    await h.run()

    expect(h.passthrough).toEqual([])
  })
})

describe('a run that gave up', () => {
  /**
   * The agent reports a stop and then ends the run anyway, so a `done` always
   * follows. Reading that `done` as success is what made a run that never sent
   * the message draw a checkmark over a task it had not done.
   */
  it('does not report a run that ran out of steps as completed', async () => {
    const h = harness()
    const running = h.run()

    await vi.waitFor(() => expect(state.runs).toHaveLength(1))
    state.emit({ kind: 'stopped', reason: 'the step budget ran out' })
    state.emit({ kind: 'done', complete: false, answer: 'Stopped after 3 steps without finishing the task.' })

    const result = await running
    expect(result.incomplete).toBe(true)
    expect(result.answer).toBe('')
    expect(h.last()).toMatchObject({ phase: 'done', completed: false })
  })

  it('does not put the loop’s own English diagnostic in the answer', async () => {
    const h = harness()
    const running = h.run()

    await vi.waitFor(() => expect(state.runs).toHaveLength(1))
    state.emit({ kind: 'stopped', reason: 'the step budget ran out' })
    state.emit({ kind: 'done', complete: false, answer: 'Stopped after 3 steps without finishing the task.' })

    const result = await running
    // The loop's closing line on this path is a diagnostic, not an answer, and
    // it is written in English. The user asked in Russian for a message to be
    // sent; they should not be shown a sentence about a step budget.
    expect(result.answer).not.toContain('Stopped after')
    expect(result.message).toContain('Не успел')
    expect(result.message).toContain('задача осталась невыполненной')
  })

  it('says what happened in Russian, with the ending the number needs', async () => {
    for (const [total, ending] of [[1, '1 шаг'], [3, '3 шага'], [8, '8 шагов']] as const) {
      state.maxSteps = total
      state.runs = []
      const h = harness()
      const running = h.run()
      await vi.waitFor(() => expect(state.runs).toHaveLength(1))
      state.emit({ kind: 'stopped', reason: 'the step budget ran out' })
      state.emit({ kind: 'done', complete: false, answer: 'Stopped.' })

      const result = await running
      expect(result.message).toContain(ending)
    }
  })

  it('does not treat a loop-guard warning as a failure', async () => {
    // The guard warns and the run continues, so a run that recovered from it
    // finished. Recording the warning as a stop is what made this ambiguous.
    const h = harness()
    const running = h.run()

    await vi.waitFor(() => expect(state.runs).toHaveLength(1))
    state.emit({ kind: 'warning', reason: 'the same call repeated without a change' })
    state.emit({ kind: 'done', answer: 'Сообщение отправлено.', complete: true })

    const result = await running
    expect(result.incomplete).toBeUndefined()
    expect(result.answer).toBe('Сообщение отправлено.')
    expect(h.last()).toMatchObject({ phase: 'done', completed: true })
  })

  it('records the warning without turning it into a verdict', async () => {
    const h = harness()
    const running = h.run()

    await vi.waitFor(() => expect(state.runs).toHaveLength(1))
    state.emit({ kind: 'warning', reason: 'the same call repeated without a change' })
    state.emit({ kind: 'done', answer: 'Готово.', complete: true })
    await running

    expect(h.trace().find((line) => line.event === 'agent.warned'))
      .toMatchObject({ reason: 'the same call repeated without a change' })
    expect(h.trace().some((line) => line.event === 'agent.stopped')).toBe(false)
  })

  it('still reports a run unfinished when it stops for a reason it does not recognise', async () => {
    // The loop can only send three reasons, but a sidecar built before a wording
    // change would send something else. The card must still say the task was not
    // finished rather than inventing advice about a limit.
    const h = harness()
    const running = h.run()

    await vi.waitFor(() => expect(state.runs).toHaveLength(1))
    state.emit({ kind: 'stopped', reason: 'the same call repeated without a change' })
    state.emit({ kind: 'done', complete: false, answer: 'Stopped.' })

    const result = await running
    expect(result.incomplete).toBe(true)
    expect(result.message).toBe('Задача осталась невыполненной.')
  })

  it('names a run that kept returning to the same screen', async () => {
    // Different from a repeated call: every step tried something new and still
    // ended up on the same screen. Sending the user to the step limit would be
    // wrong advice — more steps would only repeat the loop.
    const h = harness()
    const running = h.run()

    await vi.waitFor(() => expect(state.runs).toHaveLength(1))
    state.emit({ kind: 'stopped', reason: 'the run kept returning to a screen it had already seen' })
    state.emit({ kind: 'done', complete: false, answer: 'Stopped.' })

    const result = await running
    expect(result.incomplete).toBe(true)
    expect(result.message).toContain('по кругу')
  })

  it('names the output limit when that is what stopped it', async () => {
    // A different failure from running out of steps, and a different fix: the
    // run had budget left, but every reply was cut in half. Telling the user to
    // raise the step limit would send them to the wrong setting.
    const h = harness()
    const running = h.run()

    await vi.waitFor(() => expect(state.runs).toHaveLength(1))
    state.emit({ kind: 'stopped', reason: "the model's reply was cut off at the token limit" })
    state.emit({ kind: 'done', complete: false, answer: 'Stopped: the reply was cut off.' })

    const result = await running
    expect(result.incomplete).toBe(true)
    expect(result.message).toContain('токенов')
  })

  it('still reports the model’s own sentence when the run did finish', async () => {
    const h = harness()
    const running = h.run()

    await vi.waitFor(() => expect(state.runs).toHaveLength(1))
    state.emit({ kind: 'done', complete: true, answer: 'Сообщение отправлено.' })

    const result = await running
    expect(result.incomplete).toBeUndefined()
    expect(result.answer).toBe('Сообщение отправлено.')
    expect(h.last()).toMatchObject({ phase: 'done', completed: true })
  })

  it('records the stop and the step it happened on', async () => {
    const h = harness()
    const running = h.run()

    await vi.waitFor(() => expect(state.runs).toHaveLength(1))
    state.emit({ kind: 'step', step: 3, total: 3 })
    state.emit({ kind: 'stopped', reason: 'the step budget ran out' })
    state.emit({ kind: 'done', complete: false, answer: 'Stopped.' })
    await running

    expect(h.trace().find((line) => line.event === 'agent.stopped'))
      .toMatchObject({ reason: 'the step budget ran out', step: 3 })
  })
})

describe('a run that works', () => {
  it('hands the card the click-through, then gives it back', async () => {
    const h = harness()
    const running = h.run()

    // The card has to be click-through before the first call: it sits over the
    // window the agent is about to press.
    await vi.waitFor(() => expect(h.passthrough).toEqual([true]))
    state.emit({ kind: 'done', complete: true, answer: 'Куплено.' })
    await running

    expect(h.passthrough).toEqual([true, false])
  })

  it('reports the agent’s own closing sentence as the answer', async () => {
    const h = harness()
    const running = h.run()

    await vi.waitFor(() => expect(state.runs).toHaveLength(1))
    state.emit({ kind: 'narration', step: 1, text: 'Нажимаю «Купить»' })
    state.emit({ kind: 'result', step: 1, name: 'click', ok: true, text: 'ok', timing: {} })
    state.emit({ kind: 'done', complete: true, answer: 'Товар в корзине.' })

    const result = await running
    expect(result.answer).toBe('Товар в корзине.')
    expect(result.actions).toEqual([{ tool: 'click', label: 'Нажимаю «Купить»', ok: true }])
  })

  it('passes the task, the step budget and the verification flag through', async () => {
    state.maxSteps = 5
    state.verifyResult = false
    const h = harness()
    const running = h.run()

    await vi.waitFor(() => expect(state.runs).toHaveLength(1))
    state.emit({ kind: 'done', complete: true, answer: '' })
    await running

    expect(state.runs[0]).toMatchObject({
      maxSteps: 5,
      verifyActions: false,
      // The app and the window are context, not instructions: the agent decides
      // where to look by calling its own tool.
      task: 'Приложение: Safari\nОкно: Магазин\n\nНажми «Купить»'
    })
  })

  it('passes the exclusions the caller configured', async () => {
    const h = harness()
    const running = h.controller.run({
      prompt: 'Нажми «Купить»',
      appName: 'Safari',
      windowTitle: 'Магазин',
      provider: PROVIDER,
      excludedApps: ['com.apple.finder']
    })

    await vi.waitFor(() => expect(state.runs).toHaveLength(1))
    state.emit({ kind: 'done', complete: true, answer: '' })
    await running

    expect(state.runs[0]).toMatchObject({ excludedApps: ['com.apple.finder'] })
  })

  it('gives the agent the turns a follow-up refers to', async () => {
    const h = harness()
    const running = h.run('сделай', [
      {
        question: 'можно ли сделать так, чтобы чеки попадали в отдельную папку? если да — сделай',
        answer: 'Да, можно: создайте фильтр в настройках Gmail.'
      }
    ])

    await vi.waitFor(() => expect(state.runs).toHaveLength(1))
    state.emit({ kind: 'done', complete: true, answer: '' })
    await running

    const task = (state.runs[0] as { task: string }).task
    // The bare imperative is still the request; the earlier turn is what makes
    // it mean something.
    expect(task).toContain('Разговор до этого')
    expect(task).toContain('Пользователь: можно ли сделать так, чтобы чеки')
    expect(task).toContain('Ответ: Да, можно')
    expect(task.endsWith('Текущая задача:\nсделай')).toBe(true)
  })

  it('does not add a history block to a first request', async () => {
    const h = harness()
    const running = h.run('Нажми «Купить»', [])

    await vi.waitFor(() => expect(state.runs).toHaveLength(1))
    state.emit({ kind: 'done', complete: true, answer: '' })
    await running

    expect((state.runs[0] as { task: string }).task).not.toContain('Разговор до этого')
  })

  it('forwards the picture of an action without turning it into a phase', async () => {
    const h = harness()
    const running = h.run()

    await vi.waitFor(() => expect(state.runs).toHaveLength(1))
    const presentation: AgentPresentation = {
      tool: 'click',
      gesture: 'click',
      app: 'Safari',
      point: { x: 120, y: 300 },
      target: { x: 100, y: 290, width: 40, height: 20 }
    }
    state.emit({ kind: 'present', presentation })

    expect(h.presentations).toEqual([presentation])
    // A picture is not progress: the card is still where the run left it.
    expect(h.last().phase).toBe('arming')

    state.emit({ kind: 'done', complete: true, answer: '' })
    await running
  })

  it('passes the presentation switch through to the agent', async () => {
    state.showActions = false
    const h = harness()
    const running = h.run()

    await vi.waitFor(() => expect(state.runs).toHaveLength(1))
    state.emit({ kind: 'done', complete: true, answer: '' })
    await running

    // Same run, no picture. This is the seam a background mode uses.
    expect(state.runs[0]).toMatchObject({ visualize: false })
  })

  it('asks for the picture when the user left the switch on', async () => {
    const h = harness()
    const running = h.run()

    await vi.waitFor(() => expect(state.runs).toHaveLength(1))
    state.emit({ kind: 'done', complete: true, answer: '' })
    await running

    expect(state.runs[0]).toMatchObject({ visualize: true })
  })

  it('gives an agent step more output room than the writer’s 1024', async () => {
    // A tool call with nested JSON does not fit in 1024 tokens: the reply is cut
    // off mid-call, the half-written call parses into nothing, and the step
    // arrives as an empty answer. The run is then lost with no sign of why.
    const h = harness()
    const running = h.run()

    await vi.waitFor(() => expect(state.runs).toHaveLength(1))
    state.emit({ kind: 'done', complete: true, answer: '' })
    await running

    const provider = (state.runs[0] as { provider: { maxTokens: number } }).provider
    expect(provider.maxTokens).toBeGreaterThanOrEqual(AGENT_MIN_OUTPUT_TOKENS)
  })

  it('keeps a larger budget the user chose instead of lowering it', async () => {
    const h = harness({ maxTokens: 8192 })
    const running = h.run()

    await vi.waitFor(() => expect(state.runs).toHaveLength(1))
    state.emit({ kind: 'done', complete: true, answer: '' })
    await running

    const provider = (state.runs[0] as { provider: { maxTokens: number } }).provider
    expect(provider.maxTokens).toBe(8192)
  })
})

describe('the question in the card', () => {
  it('lifts the click-through, asks, and puts it back on "да"', async () => {
    const h = harness()
    const running = h.run()
    await vi.waitFor(() => expect(h.passthrough).toEqual([true]))

    state.emit({ kind: 'approval', request: call() })

    expect(h.last()).toMatchObject({ phase: 'asking', approval: expect.objectContaining({ id: 'call-1' }) })
    // The card takes the mouse back for exactly as long as the question is open.
    expect(h.passthrough).toEqual([true, false])

    h.controller.answer('call-1', true, false)

    expect(state.approvals).toEqual([{ id: 'call-1', allow: true }])
    expect(h.last()).toMatchObject({ phase: 'acting', approval: null })
    expect(h.passthrough).toEqual([true, false, true])

    state.emit({ kind: 'done', complete: true, answer: 'Готово.' })
    await running
  })

  it('remembers a "разрешить всегда" by fingerprint, and nothing else', async () => {
    const h = harness()
    const running = h.run()
    await vi.waitFor(() => expect(h.passthrough).toEqual([true]))

    state.emit({ kind: 'approval', request: call() })
    h.controller.answer('call-1', true, true)

    expect(state.remembered).toHaveLength(1)
    expect(state.remembered[0]).toMatch(/^[a-f0-9]{64}$/)

    // The same fingerprint is no longer asked about…
    state.emit({ kind: 'approval', request: call({ id: 'call-2' }) })
    expect(h.last().phase).toBe('acting')
    expect(state.approvals.at(-1)).toEqual({ id: 'call-2', allow: true })

    // …but a different one still is.
    state.emit({ kind: 'approval', request: call({ id: 'call-3', fingerprint: 'b'.repeat(64) }) })
    expect(h.last().phase).toBe('asking')

    h.controller.answer('call-3', false, false)
    state.emit({ kind: 'done', complete: true, answer: '' })
    await running
  })

  it('turns a refusal into a stop, with the reason on the card', async () => {
    const h = harness()
    const running = h.run()
    await vi.waitFor(() => expect(h.passthrough).toEqual([true]))

    state.emit({ kind: 'approval', request: call() })
    h.controller.answer('call-1', false, false)

    expect(state.approvals).toEqual([{ id: 'call-1', allow: false, reason: 'Пользователь отклонил действие.' }])
    expect(h.last()).toMatchObject({ phase: 'aborted', approval: null, message: 'Действие отклонено.' })

    state.emit({ kind: 'cancelled' })
    const result = await running
    expect(result.aborted).toBe(true)
  })

  it('answers harmless calls itself, without troubling the user', async () => {
    const h = harness()
    const running = h.run()
    await vi.waitFor(() => expect(h.passthrough).toEqual([true]))

    // Scrolling is what the mode is for; asking about it would train the user to
    // click "разрешить" without reading.
    state.emit({ kind: 'approval', request: call({ id: 'call-1', tool: 'scroll', title: undefined }) })

    expect(state.approvals).toEqual([{ id: 'call-1', allow: true }])
    expect(h.passthrough).toEqual([true])

    state.emit({ kind: 'done', complete: true, answer: '' })
    await running
  })

  it('never lets a password be typed, and does not ask about it', async () => {
    const h = harness()
    const running = h.run()
    await vi.waitFor(() => expect(h.passthrough).toEqual([true]))

    state.emit({
      kind: 'approval',
      request: call({ id: 'call-1', tool: 'type_text', title: 'Пароль', fingerprint: '' })
    })

    expect(state.approvals).toEqual([
      { id: 'call-1', allow: false, reason: 'Секреты и пароли введи вручную.' }
    ])
    // A refusal that is not the user's decision must not lift the click-through.
    expect(h.passthrough).toEqual([true])

    state.emit({ kind: 'done', complete: true, answer: '' })
    await running
  })

  it('ignores an answer for a question that is no longer open', async () => {
    const h = harness()
    const running = h.run()
    await vi.waitFor(() => expect(h.passthrough).toEqual([true]))

    state.emit({ kind: 'approval', request: call() })
    h.controller.answer('call-1', true, false)
    // A second press, or a stale button: the run has already moved on.
    h.controller.answer('call-1', false, false)

    expect(state.approvals).toEqual([{ id: 'call-1', allow: true }])

    state.emit({ kind: 'done', complete: true, answer: '' })
    await running
  })
})

describe('stopping', () => {
  it('refuses the open question, cancels the agent and settles the run', async () => {
    const h = harness()
    const running = h.run()
    await vi.waitFor(() => expect(h.passthrough).toEqual([true]))
    state.emit({ kind: 'approval', request: call() })

    h.controller.stop('Остановлено: ты взял мышь.')

    // A stop that did not answer the question would be a stop that never lands:
    // the agent is blocked on it.
    expect(state.approvals).toEqual([{ id: 'call-1', allow: false, reason: 'Отменено.' }])
    expect(state.cancels).toBe(1)
    expect(h.last()).toMatchObject({ phase: 'aborted', message: 'Остановлено: ты взял мышь.' })

    const result = await running
    expect(result.aborted).toBe(true)
    expect(h.passthrough).toEqual([true, false, false])
  })

  it('is safe with nothing running', () => {
    const h = harness()
    h.controller.stop()
    expect(state.cancels).toBe(1)
    expect(h.events).toHaveLength(0)
  })
})

describe('the agent dying mid-run', () => {
  it('reports the failure on the card instead of hanging in "acting"', async () => {
    const h = harness()
    const running = h.run()
    await vi.waitFor(() => expect(h.passthrough).toEqual([true]))

    state.emit({ kind: 'error', message: 'Агент остановился (SIGKILL).' })

    const result = await running
    expect(result.message).toBe('Агент остановился (SIGKILL).')
    expect(h.last()).toMatchObject({ phase: 'error', message: 'Агент остановился (SIGKILL).' })
    expect(h.passthrough).toEqual([true, false])
  })

  it('reports a failure to start as a blocked run', async () => {
    state.runRejects = new Error('Компонент агента не собран.')
    const h = harness()

    const result = await h.run()

    expect(result).toMatchObject({ blocked: true, message: 'Компонент агента не собран.' })
    expect(h.passthrough).toEqual([true, false])
  })
})

describe('the trace a run leaves behind', () => {
  /**
   * The trace is the only place a slow run can be diagnosed after the fact, so
   * what it records is part of the contract: a step without its cost, or a call
   * without its phases, would leave the one question the trace exists to answer
   * — "what took the time" — unanswerable.
   */
  it('records each step, its round trip, and each call with its phases', async () => {
    const h = harness()
    const running = h.run()
    await vi.waitFor(() => expect(state.runs).toHaveLength(1))

    state.emit({ kind: 'step', step: 1, total: 3 })
    state.emit({
      kind: 'stepTiming',
      step: 1,
      timing: { llmMs: 1432.5, promptBytes: 20823, history: 4, calls: 1, inputTokens: 900, outputTokens: 40 }
    })
    state.emit({ kind: 'tool', step: 1, name: 'get_app_state', args: { app: 'Finder' } })
    state.emit({
      kind: 'result', step: 1, name: 'get_app_state', ok: true, text: 'tree',
      timing: { wallMs: 493.02, treeMs: 476.35, captureMs: 12.1, imageBytes: 151812 }
    })
    state.emit({
      kind: 'runReport',
      report: { steps: 1, calls: 1, failedCalls: 0, totalMs: 1950.4, llmMs: 1432.5, toolMs: 493.02 }
    })
    state.emit({ kind: 'done', complete: true, answer: 'Готово.' })
    await running

    const lines = h.trace()
    const events = lines.map((line) => line.event)
    expect(events).toContain('agent.step')
    expect(events).toContain('agent.llm')
    expect(events).toContain('agent.tool')
    expect(events).toContain('agent.call')
    expect(events).toContain('agent.report')

    const llm = lines.find((line) => line.event === 'agent.llm')!
    expect(llm).toMatchObject({
      step: 1, llmMs: 1432.5, promptBytes: 20823, history: 4, calls: 1,
      inputTokens: 900, outputTokens: 40
    })

    // The phases are what makes a 493 ms call diagnosable: without the split it
    // is indistinguishable from a slow model, and the fix is in a different file.
    const call = lines.find((line) => line.event === 'agent.call')!
    expect(call).toMatchObject({
      step: 1, tool: 'get_app_state', ok: true,
      wallMs: 493, treeMs: 476.4, captureMs: 12.1, imageBytes: 151812
    })
    // A phase that did not run is absent, not zero.
    expect('encodeMs' in call).toBe(false)

    const report = lines.find((line) => line.event === 'agent.report')!
    expect(report).toMatchObject({ steps: 1, calls: 1, failedCalls: 0, totalMs: 1950.4 })
    expect(report.modelShare).toBe(73)
  })

  it('keeps the timings table out of the trace when the agent did not build one', async () => {
    const h = harness()
    const running = h.run()
    await vi.waitFor(() => expect(state.runs).toHaveLength(1))

    state.emit({
      kind: 'runReport',
      report: { steps: 1, calls: 0, failedCalls: 0, totalMs: 10, llmMs: 10, toolMs: 0 }
    })
    state.emit({ kind: 'done', complete: true, answer: '' })
    await running

    expect(h.trace().some((line) => line.event === 'agent.timings')).toBe(false)
  })
})
