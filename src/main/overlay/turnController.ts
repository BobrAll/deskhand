import { createHash } from 'node:crypto'
import { looksLikeAction } from '@shared/intent'
import type { AgentEvent, SendRequest, StreamEvent, StreamEventCode } from '@shared/types'
import type { createAgentController } from '../agent'
import { beginAgentTurn, endAgentTurn } from '../agent/cursor'
import { trace, traceTurn } from '../agent/trace'
import { isExcluded } from '../context/activeApp'
import { resolveChatModel } from '../llm'
import { ProviderError } from '../llm/provider'
import { getApiKey } from '../settings/secrets'
import { getSettings } from '../settings/store'
import { readPreviousCommand, saveCommand } from './history'
import type { CardExchange, Session } from './session'
import type { createTurnRunners, TurnContext } from './turnRunners'

/**
 * Shown when the card's app is on the exclusion list.
 *
 * The card normally never opens for such an app; this is the race where the
 * target changes while the card is already on screen.
 */
const EXCLUDED_APP = 'Приложение входит в список исключений — запрос не отправлен.'

/**
 * How long a spoken transcript stays on screen while its request is already
 * running. The old code waited this long before calling the model; now it is
 * only a floor for the card, not a pause in the work.
 */
const VOICE_PREVIEW_MS = 2_000

/**
 * The history of the current card.
 */
const CARD_HISTORY_TURNS = 2

/**
 * Ceiling for one side of a remembered exchange, question or answer. A long
 * answer is still referenced by its beginning — the part the follow-up is about —
 * and this keeps two turns of history from costing more than the question itself.
 */
const MAX_HISTORY_CHARS = 1_500

const STOP_AGENT = Symbol('stop-agent')
const TURN_DEADLINE_MS = 120_000

interface TurnControllerHost {
  currentSession(): Session | null
  agent: Pick<ReturnType<typeof createAgentController>, 'stop' | 'availability' | 'last'>
  runners: ReturnType<typeof createTurnRunners>
  cardVisible(): boolean | undefined
  showCard(): void
  hideCard(): void
  discardAnnotations(): void
  emitStream(event: StreamEvent): void
  publishAgent(event: AgentEvent): void
}

export function createTurnController({
  currentSession,
  agent,
  runners,
  cardVisible,
  showCard,
  hideCard,
  discardAnnotations,
  emitStream,
  publishAgent
}: TurnControllerHost) {
  const { runAgentTurn, runWriterTurn } = runners

  /**
   * The spoken turn still in flight.
   *
   * A new press supersedes it immediately: while a voice answer is streaming or
   * an agent is clicking, the user pressing the key again means they are already
   * saying the next thing, and the old turn must not keep acting underneath them.
   */
  let voiceTurn: AbortController | null = null
  function send(request: SendRequest): Promise<void> {
    if (!currentSession() || request.refine) return sendTurn(request)
    const settings = getSettings()
    // A short digest of everything that changes what a run does, so the trace can
    // group runs by configuration without recording any of the values — a model
    // name and a temperature are the user's business, not the log's.
    const config = createHash('sha256')
      .update(
        JSON.stringify([
          settings.provider,
          resolveChatModel(settings),
          settings.temperature,
          settings.maxTokens,
          settings.agent.enabled,
          settings.agent.maxSteps,
          settings.agent.verifyResult,
          settings.agent.abortOnMouseMove,
          settings.screenshotMaxSide,
          settings.screenshotQuality
        ])
      )
      .digest('hex')
      .slice(0, 12)
    return traceTurn({ voice: request.voice === true, provider: settings.provider, config }, () => sendTurn(request))
  }

  async function sendTurn(request: SendRequest): Promise<void> {
    const session = currentSession()
    if (!session) return
    const settings = getSettings()

    const fail = (message: string, retryable: boolean, code?: StreamEventCode): void => {
      const event: StreamEvent = { type: 'error', requestId: request.requestId, message, retryable, code }
      emitStream(event)
      if (request.voice) showCard()
    }

    // The card normally closes before a turn can start in an excluded app, but
    // the target can change while it is already on screen. The error is what
    // clears the busy state; a bare return left the card waiting forever.
    if (isExcluded(session.target, settings.excludedApps)) {
      trace('turn.outcome', { outcome: 'blocked', reason: 'excluded-app' })
      fail(EXCLUDED_APP, false)
      return
    }
    const model = resolveChatModel(settings)
    const apiKey = getApiKey(settings.provider)

    if (!model) {
      fail('Модель не выбрана. Открой настройки и укажи модель.', false)
      return
    }
    if (!apiKey) {
      trace('turn.outcome', { outcome: 'blocked', reason: 'missing-key' })
      fail('Не задан ключ API. Открой настройки и добавь ключ.', false)
      return
    }

    // "Короче / длиннее": the previous answer is the whole input, so no context,
    // no screenshot and no selection are re-sent.
    const refine = request.refine ?? null
    const baseAnswer = refine ? refine.baseAnswer.trim() : ''
    if (refine && !baseAnswer) {
      fail('Пока нечего переписывать — сначала получи ответ.', false)
      return
    }

    session.abort?.abort()
    // A new question is a new turn: a plan from the previous answer must not be
    // able to keep clicking into this one.
    agent.stop()

    const abort = new AbortController()
    session.abort = abort
    // A spoken turn belongs to the microphone from the moment it is sent: the
    // next press must be able to stop it without waiting for the answer.
    if (request.voice) voiceTurn = abort
    session.requestId = request.requestId
    session.answer = ''
    const availability = agent.availability()
    /**
     * Whether this turn is for the agent rather than for the writer.
     *
     * This is the one routing decision in the turn, and it is made before any
     * model is called: an action request must not pay for a text round first,
     * because that round's only job would be to guess what the agent is about
     * to do anyway.
     *
     * The rule is the verb, not the mode. `looksLikeAction` is the same gate that
     * already decides whether the pointer glow promises an action, so the card and
     * the routing cannot disagree: if the glow said "готовлю действия", the agent
     * runs. When the agent cannot run — mode off, no Accessibility — the turn
     * falls through to the writer with `actReason` set, which is what produces the
     * honest "я не могу нажать, вот почему" answer instead of a silent arrow.
     */
    const isActionRequest = !refine && availability.ready && looksLikeAction(request.prompt)
    // Claim before screenshot/AX/model work, including cancellation mid-turn.
    const glowTurn = beginAgentTurn(isActionRequest)
    const turnSession = session
    let outcome = 'abandoned'
    let reason = 'session-changed'
    let deadline: ReturnType<typeof setTimeout> | undefined
    /**
     * Hides the card after a spoken transcript has had its reading time, if the
     * answer has not arrived by then. It is a timer, not an `await`, precisely so
     * the model round trip starts now.
     */
    let previewHide: ReturnType<typeof setTimeout> | undefined
    const previewUntil = request.voice && cardVisible() ? Date.now() + VOICE_PREVIEW_MS : 0
    try {
      // A spoken request is routed immediately. The transcript stays in the
      // composer while the turn is busy (the renderer keeps it until the first
      // answer chunk), so reading it and starting the work happen in parallel
      // instead of the card sitting still for two seconds first.
      deadline = setTimeout(() => abort.abort('deadline'), TURN_DEADLINE_MS)
      const bundleId = turnSession.target?.bundleId || null
      // The exclusion list was already checked before the turn was registered,
      // and nothing has been awaited since: the same `settings` still describe
      // this turn.
      const useHistory = settings.rememberConversation
      const history = turnSession.history.filter(
        (entry) => !entry.bundleId || !settings.excludedApps.includes(entry.bundleId)
      )
      const previousCommand =
        useHistory && !refine && turnSession.history.length === 0
          ? readPreviousCommand(settings.excludedApps)
          : undefined

      if (request.voice && !isActionRequest) {
        // The request is already under way. Give the reader the transcript for
        // its two seconds and only then get the card out of the way; if the
        // answer arrives sooner, the `finally` clears this timer and the answer
        // takes the card instead of being hidden by it.
        const wait = previewUntil - Date.now()
        if (wait > 0) {
          previewHide = setTimeout(() => {
            previewHide = undefined
            if (currentSession() === turnSession && !abort.signal.aborted) hideCard()
          }, wait)
        } else {
          hideCard()
        }
      }

      // The drawings belong to the answer currently on screen: a new question
      // replaces that answer, so old arrows must not stay behind as if they
      // explained the new one. A rewrite ("короче") keeps them — it is the same
      // answer in other words.
      if (!refine) discardAnnotations()

      const turn: TurnContext = {
        request,
        session: turnSession,
        settings,
        apiKey,
        refine,
        history,
        previousCommand,
        useHistory,
        availability,
        abort
      }
      const result = isActionRequest ? await runAgentTurn(turn) : await runWriterTurn(turn)
      if (!result) return

      // The turn's own session, not the module-level one: the runner returned
      // only because both still point at the same card.
      turnSession.answer = result.answer
      outcome = result.outcome
      reason = result.reason

      const entry = remember(turnSession, request, result.acknowledged ? 'Готово.' : result.answer, bundleId)
      const latestSettings = getSettings()
      if (entry && !refine && useHistory && latestSettings.rememberConversation) {
        saveCommand(entry.question, bundleId, latestSettings.excludedApps)
      }

      const done: StreamEvent = {
        type: 'done',
        requestId: request.requestId,
        text: result.answer,
        annotations: turnSession.annotations.length
      }
      emitStream(done)
      if (result.acknowledged || result.answer.trim()) {
        // A voice turn, an agent turn and a card that was hidden while it waited
        // all end with the answer arriving rather than streaming: the card has to
        // be brought back to show it.
        if (request.voice || isActionRequest || !cardVisible()) {
          showCard()
        }
      } else if (request.voice) {
        // Nothing to show and nothing to read: keep the card only when the answer
        // would have been spoken, because then the user needs the text of it.
        if (getSettings().voice.answerVoice !== 'off') showCard()
        else hideCard()
      }
    } catch (error) {
      outcome = 'error'
      reason = error instanceof ProviderError ? 'provider' : 'internal'
      trace('turn.error', { providerError: error instanceof ProviderError, aborted: abort.signal.aborted })
      if (abort.signal.aborted) return
      if (error instanceof ProviderError) {
        fail(error.message, error.retryable)
        return
      }
      fail(error instanceof Error ? error.message : 'Неизвестная ошибка запроса.', true)
    } finally {
      clearTimeout(deadline)
      if (previewHide) {
        clearTimeout(previewHide)
        previewHide = undefined
      }
      if (abort.signal.aborted) {
        outcome = abort.signal.reason === 'deadline' ? 'timeout' : 'cancelled'
        reason = outcome === 'timeout' ? 'deadline' : abort.signal.reason === STOP_AGENT ? 'agent-stop' : 'turn-abort'
        if (currentSession() === turnSession && turnSession.abort === abort) {
          if (outcome === 'timeout') fail('Время выполнения истекло. Результат не подтверждён.', true, 'timeout')
          else if (abort.signal.reason === STOP_AGENT) {
            if (agent.last().phase !== 'aborted')
              publishAgent({
                phase: 'aborted',
                step: 0,
                total: 0,
                label: '',
                message: 'Остановлено.'
              })
            emitStream({
              type: 'done',
              requestId: request.requestId,
              text: '',
              annotations: 0
            } satisfies StreamEvent)
          }
        }
      }
      trace('turn.outcome', { outcome, reason })
      trace('turn.finished', { aborted: abort.signal.aborted })
      if (turnSession.abort === abort) turnSession.abort = null
      if (voiceTurn === abort) voiceTurn = null
      endAgentTurn(glowTurn)
    }
  }

  function cancel(requestId: string): void {
    const session = currentSession()
    if (session?.requestId === requestId) session.abort?.abort()
  }

  /**
   * Appends a finished turn to the conversation.
   *
   * A rewrite replaces the answer it reworked instead of adding a turn: "короче"
   * is the same answer in other words, and remembering both would have the model
   * follow up on a text that is no longer on screen.
   */
  function remember(
    turnSession: Session,
    request: SendRequest,
    answer: string,
    bundleId: string | null
  ): CardExchange | null {
    const question = request.prompt.trim()
    const reply = answer.trim()
    if (!question || !reply) return null

    const entry: CardExchange = {
      bundleId,
      question: question.length > MAX_HISTORY_CHARS ? `${question.slice(0, MAX_HISTORY_CHARS)}…` : question,
      answer: reply.length > MAX_HISTORY_CHARS ? `${reply.slice(0, MAX_HISTORY_CHARS)}…` : reply
    }
    const last = turnSession.history[turnSession.history.length - 1]
    if (request.refine && last?.question === entry.question) {
      turnSession.history[turnSession.history.length - 1] = entry
    } else {
      turnSession.history.push(entry)
    }
    // Oldest first out: the last `CARD_HISTORY_TURNS` exchanges are what a follow-up
    // can refer to, and everything older only costs tokens.
    if (turnSession.history.length > CARD_HISTORY_TURNS) {
      turnSession.history.splice(0, turnSession.history.length - CARD_HISTORY_TURNS)
    }
    return entry
  }

  function stopAgent(): void {
    agent.stop()
    currentSession()?.abort?.abort(STOP_AGENT)
  }

  return { send, cancel, stopAgent, abortSpokenTurn: () => voiceTurn?.abort() }
}
