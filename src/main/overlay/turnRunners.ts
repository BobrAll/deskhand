import { parseExtraBody, resolveBaseUrl } from '@shared/defaults'
import { allowsWebLookup } from '@shared/intent'
import type {
  AgentAvailability,
  AgentRunResult,
  Annotation,
  AxElementInfo,
  ScreenRect,
  ScreenshotInfo,
  SendRequest
} from '@shared/types'
import type { createAgentController } from '../agent'
import { describeScreen as readScreenOutline } from '../agent/outline'
import type { AgentProvider } from '../agent/sidecar'
import { timed, trace } from '../agent/trace'
import { getProvider, resolveChatModel } from '../llm'
import { ProviderError, type ChatMessage } from '../llm/provider'
import { searchWeb } from '../llm/webSearch'
import type { RawFrontApp } from '../native/helper'
import { getSettings } from '../settings/store'
import { consumeTurnStream } from '../turnStream'
import { emptyAnswerFallback } from './emptyAnswer'
import { buildTurnRequest, type TurnRequest } from './request'
import type { CardExchange, Session } from './session'

/** Everything the two halves of a turn share. */
export interface TurnContext {
  request: SendRequest
  session: Session
  settings: ReturnType<typeof getSettings>
  apiKey: string
  /** The rewrite this turn is, or `null` for a normal question. */
  refine: NonNullable<SendRequest['refine']> | null
  /** The conversation, already filtered against the excluded apps. */
  history: CardExchange[]
  previousCommand: string | undefined
  useHistory: boolean
  availability: AgentAvailability
  abort: AbortController
}

/** What a finished turn leaves on the card, and how the trace names it. */
interface TurnResult {
  answer: string
  outcome: string
  reason: string
  /** The agent reported success without anything to say. */
  acknowledged: boolean
}

/**
 * Shown when the provider refuses the screenshot.
 *
 * The turn continues without it, so this is a notice, not an error: the answer
 * arrives, and the only thing that changed is that the model could not see the
 * screen and therefore did not draw on it.
 */
const MODEL_REFUSED_IMAGE = 'Модель не принимает изображения — ответ получен без скриншота и рисунка.'

/** The agent's exact reply for success without caveats. */
const AGENT_DONE_MARKER = '[[ACTION_DONE]]'

/** What OpenRouter wants on every request to attribute the traffic to this app. */
const OPENROUTER_ATTRIBUTION = {
  'HTTP-Referer': 'https://github.com/BobrAll/deskhand',
  'X-Title': 'Deskhand'
}

/**
 * How the trace names a finished agent run.
 *
 * The outcome and its reason come from the same flags, so they are decided
 * together: written as two separate chains they were easy to drift apart.
 */
function describeRunOutcome(run: AgentRunResult, acknowledged: boolean): { outcome: string; reason: string } {
  const spoke = run.answer.trim().length > 0
  const outcome = run.blocked
    ? 'blocked'
    : run.aborted
      ? 'cancelled'
      : run.incomplete
        ? 'incomplete'
        : spoke && !acknowledged
          ? 'agent-report'
          : 'agent-silent'
  const reason = run.blocked
    ? 'agent-unavailable'
    : run.aborted
      ? 'agent-stop'
      : run.incomplete
        ? 'agent-incomplete'
        : acknowledged
          ? 'agent-acknowledged'
          : spoke
            ? 'agent-answer'
            : 'no-answer'
  return { outcome, reason }
}

interface TurnHost {
  agent: Pick<ReturnType<typeof createAgentController>, 'run' | 'stop' | 'last'>
  isCurrent(target: Session): boolean
  hasSession(): boolean
  ensureFreshScreenshot(target: Session, requireObserved?: boolean): Promise<ScreenshotInfo | null>
  observedAppFor(shot: ScreenshotInfo): RawFrontApp | undefined
  windowStillMatches(observed: RawFrontApp): Promise<boolean>
  publishState(): void
  revealCard(): void
  createPainter(canDraw: boolean, area: ScreenRect | null, targets?: AxElementInfo[]): (shapes: Annotation[]) => void
  appendText(requestId: string, delta: string, revealText?: boolean): void
}

export function createTurnRunners({
  agent,
  isCurrent,
  hasSession,
  ensureFreshScreenshot,
  observedAppFor,
  windowStillMatches,
  publishState,
  revealCard,
  createPainter,
  appendText
}: TurnHost) {
  async function streamRound(options: {
    messages: ChatMessage[]
    requestId: string
    maxTokens: number
    signal: AbortSignal
    canDraw: boolean
    area: ScreenRect | null
    apiKey: string
    /** Reveal a spoken answer as soon as its first text arrives. */
    revealText?: boolean
    drawingTargets?: AxElementInfo[]
  }): Promise<{ text: string; webLookup?: boolean }> {
    const { messages, requestId, maxTokens, signal, canDraw, area, apiKey } = options
    const settings = getSettings()

    const paint = createPainter(canDraw, area, options.drawingTargets)
    const append = (delta: string): void => {
      appendText(requestId, delta, options.revealText)
    }

    // Everything that is not about this window — parsing, filtering, the tail —
    // lives in `consumeTurnStream`, so it can be driven by a fake provider.
    const result = await timed(
      'model.round',
      () =>
        consumeTurnStream({
          provider: getProvider(settings.provider),
          messages,
          apiKey,
          streamOptions: {
            model: resolveChatModel(settings) ?? '',
            temperature: settings.temperature,
            maxTokens,
            baseUrl: resolveBaseUrl(settings.provider, settings.baseUrls[settings.provider]),
            extraBody: parseExtraBody(settings.extraBody[settings.provider]) ?? undefined,
            signal
          },
          isAlive: () => !signal.aborted && hasSession(),
          onAnnotations: paint,
          onText: append
        }),
      {
        provider: settings.provider,
        model: resolveChatModel(settings) ?? '',
        withImage: Boolean(area),
        imageBase64Bytes: messages.reduce(
          (size, message) =>
            size + message.parts.reduce((total, part) => total + (part.type === 'image' ? part.base64.length : 0), 0),
          0
        )
      }
    )
    return result
  }

  /**
   * The writer's half of a turn: build the request, stream it, and — when the
   * model asked for it — replace the answer with a web search.
   *
   * Returns `null` when the turn was abandoned: the card closed while the request
   * was being built, or the abort fired between the awaits.
   */
  async function runWriterTurn(turn: TurnContext): Promise<TurnResult | null> {
    const {
      request,
      session: turnSession,
      settings,
      apiKey,
      refine,
      history,
      previousCommand,
      availability,
      abort
    } = turn
    let observedApp: RawFrontApp | undefined
    let drawingTargets: AxElementInfo[] = []

    /**
     * Whether the picture the outline is measured against still shows the same
     * window. Drops the observation when it does not, so nothing downstream can
     * name a window that is no longer in front.
     */
    const observationHolds = async (): Promise<boolean> => {
      if (!observedApp) return true
      if (await windowStillMatches(observedApp)) return true
      observedApp = undefined
      return false
    }

    /**
     * One model round for a request built here.
     *
     * The two rounds of a turn differ only in their frame: the retry after a
     * refused image has neither a picture nor the names measured against one.
     * Everything that identifies the turn — its id, its abort signal, whether the
     * text is spoken — stays the same, so it is passed once.
     */
    const streamBuilt = (
      turnRequest: TurnRequest,
      frame: { canDraw: boolean; area: ScreenRect | null; drawingTargets: AxElementInfo[] }
    ): Promise<{ text: string; webLookup?: boolean }> =>
      streamRound({
        messages: turnRequest.messages,
        requestId: request.requestId,
        maxTokens: turnRequest.maxTokens,
        signal: abort.signal,
        canDraw: frame.canDraw,
        area: frame.area,
        apiKey,
        drawingTargets: frame.drawingTargets,
        revealText: request.voice
      })

    const built = await buildTurnRequest({
      request,
      session: turnSession,
      history,
      previousCommand,
      settings,
      availability,
      ensureFreshScreenshot: async () => {
        const shot = await ensureFreshScreenshot(turnSession, settings.agent.enabled)
        observedApp = shot ? observedAppFor(shot) : undefined
        return shot
      },
      describeScreen: async (pid, bounds, area) => {
        if (!(await observationHolds())) return null
        const outline = await readScreenOutline(
          observedApp?.pid ?? pid,
          observedApp?.bounds ?? bounds,
          area,
          (targets) => {
            drawingTargets = targets
          }
        )
        if (!(await observationHolds())) {
          drawingTargets = []
          return null
        }
        return observedApp
          ? [`Активное приложение на свежем снимке: ${observedApp.name}`, outline].filter(Boolean).join('\n')
          : outline
      },
      aborted: () => abort.signal.aborted || !isCurrent(turnSession)
    })
    if (built.abandoned || abort.signal.aborted || !isCurrent(turnSession)) return null

    let round: { text: string; webLookup?: boolean }
    try {
      round = await streamBuilt(built, {
        canDraw: built.canDraw,
        area: built.area,
        drawingTargets
      })
    } catch (error) {
      // The provider refused the picture. Whether a model takes images is not
      // knowable before the call — the user names it — so the refusal itself is
      // the answer, and it is not worth ending the turn over: the same question
      // is asked again without the screenshot, and the card says why the answer
      // has no drawing.
      if (!(error instanceof ProviderError) || !error.imageRejected || !built.useImage) throw error
      if (abort.signal.aborted || !isCurrent(turnSession)) return null
      turnSession.notices = [...turnSession.notices, MODEL_REFUSED_IMAGE]
      publishState()
      trace('turn.imageRejected', { retried: true })
      const retried = await buildTurnRequest({
        request,
        session: turnSession,
        history,
        previousCommand,
        settings,
        availability,
        omitImage: true,
        ensureFreshScreenshot: async () => null,
        describeScreen: async () => null,
        aborted: () => abort.signal.aborted || !isCurrent(turnSession)
      })
      if (retried.abandoned || abort.signal.aborted || !isCurrent(turnSession)) return null
      drawingTargets = []
      round = await streamBuilt(retried, { canDraw: false, area: null, drawingTargets })
    }
    if (abort.signal.aborted || !isCurrent(turnSession)) return null

    const webLookup = !refine && round.webLookup && allowsWebLookup(request.prompt)
    trace('tool.route', {
      backend: webLookup ? 'web-search' : 'text',
      reason: webLookup ? 'search-marker' : 'plain-response'
    })
    const webAnswer = webLookup
      ? await timed('web.search', () => searchWeb(request.prompt, settings, apiKey, abort.signal))
      : ''
    if (abort.signal.aborted || !isCurrent(turnSession)) return null

    // The round's prose is taken from the round, not from what the stream
    // happened to append: the parser is the authority on what the answer is,
    // and a delta dropped because the card closed mid-stream must not leave a
    // half-sentence behind as if it were the whole answer.
    const answer = webLookup ? webAnswer : round.text
    return {
      answer: emptyAnswerFallback(answer, turnSession.annotations.length) || answer,
      outcome: 'answer',
      reason: webLookup ? 'search-response' : 'plain-response',
      acknowledged: false
    }
  }

  /**
   * Stops the agent when the turn that started it is aborted.
   *
   * The card's Stop button, the turn deadline, a new voice press and a closed
   * card all abort the turn's controller, while the run itself only knows about
   * Escape and the mouse. Without this the agent keeps clicking after the card
   * said the turn was over. The listener lives exactly as long as the run it
   * guards, so aborting a writer turn cannot reach a run that is not its own.
   *
   * Returns the cleanup; a listener left on an old signal would stop a later
   * turn's run.
   */
  function stopAgentOnAbort(abort: AbortController): () => void {
    const stop = (): void => agent.stop()
    abort.signal.addEventListener('abort', stop, { once: true })
    return () => abort.signal.removeEventListener('abort', stop)
  }

  /**
   * The agent's half of a turn: hand the request to the plan runner and translate
   * what it did into the text the card shows and the verdict the trace records.
   *
   * Returns `null` when the card or the abort moved on while the run was in
   * flight: there is nothing left to show, and the caller's `finally` cleans up.
   */
  async function runAgentTurn(turn: TurnContext): Promise<TurnResult | null> {
    const { request, session: turnSession, settings, apiKey, history, previousCommand, useHistory, abort } = turn
    trace('tool.route', { backend: 'agent', reason: 'action-request' })
    if (abort.signal.aborted) return null
    revealCard()
    // The card shows the screen the agent is about to work on. The agent
    // takes its own captures — this one is for the person watching, and it
    // is not sent to any model.
    void ensureFreshScreenshot(turnSession).catch(() => null)

    // The agent is given the same conversation the writer would get. «Сделай»
    // is not a task on its own: it means "the thing that was just discussed",
    // and that sentence lives in the turns above it.
    const agentHistory = useHistory ? history.map(({ question, answer }) => ({ question, answer })) : []
    if (agentHistory.length === 0 && previousCommand) {
      agentHistory.push({ question: previousCommand, answer: '' })
    }

    const stopOnAbort = stopAgentOnAbort(abort)
    let run: AgentRunResult
    try {
      run = await timed('agent.run', () =>
        agent.run({
          prompt: request.prompt,
          appName: turnSession.target?.name ?? null,
          windowTitle: turnSession.target?.windowTitle ?? null,
          history: agentHistory,
          provider: agentProvider(settings, apiKey),
          excludedApps: settings.excludedApps
        })
      )
    } finally {
      stopOnAbort()
    }
    if (abort.signal.aborted || !isCurrent(turnSession)) return null

    // What the loop had to work around — a refused screenshot is the case that
    // exists today. Read from the run rather than from the agent event stream so
    // the card learns it once, at the moment the answer lands.
    const notice = agent.last()?.notice
    if (notice && !turnSession.notices.includes(notice)) {
      turnSession.notices = [...turnSession.notices, notice]
      publishState()
    }

    const report = run.answer.trim()
    const acknowledged = report === AGENT_DONE_MARKER && !run.message && !run.blocked && !run.aborted && !run.incomplete
    const answer = acknowledged ? '' : run.incomplete ? (run.message ?? '') : report || (run.message ?? '')
    const { outcome, reason } = describeRunOutcome(run, acknowledged)
    const nothingToShow = !acknowledged && run.actions.length === 0 && !run.blocked && !run.incomplete
    return {
      answer: nothingToShow ? emptyAnswerFallback(answer, 0) || answer : answer,
      outcome,
      reason,
      acknowledged
    }
  }

  /**
   * The provider configuration, in the shape the agent's process expects.
   *
   * The key is handed over per run and never written anywhere the agent could
   * keep it: the agent is a child process of this app, and the app already owns
   * the secrets file. Duplicating it into the agent's own config file would be
   * a second copy of a secret, with a second lifetime to get wrong.
   */
  function agentProvider(settings: ReturnType<typeof getSettings>, apiKey: string): AgentProvider {
    return {
      wire: settings.provider === 'anthropic' ? 'anthropic' : 'openai',
      baseUrl: resolveBaseUrl(settings.provider, settings.baseUrls[settings.provider]),
      model: resolveChatModel(settings) ?? '',
      apiKey,
      maxTokens: settings.maxTokens,
      temperature: settings.temperature,
      extraBody: parseExtraBody(settings.extraBody[settings.provider]) ?? undefined,
      // OpenRouter asks for attribution headers on every request, and the agent
      // builds its own HTTP client — it has no idea which gateway this is. The
      // writer's provider carries them; the agent's has to be told.
      headers: settings.provider === 'openrouter' ? OPENROUTER_ATTRIBUTION : undefined
    }
  }

  return { runWriterTurn, runAgentTurn }
}
