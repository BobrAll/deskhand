/** Observe → act → observe, preserving the goal and every attempt for the turn. */
import type { AgentAvailability, AppSettings, AxElementInfo, ContextSnapshot, ScreenRect, SendRequest, ScreenshotInfo } from '@shared/types'
import { trace } from '../agent/trace'
import { normalizePlan } from '../agent/plan'
import { ProgressGuard, REPEATED_PLAN } from '../agent/progress'
import { imagePart } from '../imagePart'
import type { ChatMessage, ContentPart } from '../llm/provider'
import { buildContinue, withPreviousCommand } from '../prompt'
import type { RoundResult, VerifyDeps } from './verify'

const MAX_RECOVERY_ROUNDS = 4

export interface RoundSession {
  rounds: number
  snapshot: Pick<ContextSnapshot, 'screenshot'>
}

export interface RoundsDeps {
  readonly session: RoundSession | null
  abort: AbortController
  request: SendRequest
  settings: AppSettings
  area: ScreenRect | null
  canAct: boolean
  canDraw: boolean
  apiKey: string
  maxTokens: number
  initialShot?: ScreenshotInfo | null
  round: RoundResult
  held: string
  historyMessages?: ChatMessage[]
  previousCommand?: string
  agent: {
    execute: VerifyDeps['execute']
    availability: () => AgentAvailability
  }
  publishAgent: VerifyDeps['publishAgent']
  /** Must capture after the actions; never fall back to a cached frame. */
  capture: (session: RoundSession) => Promise<ScreenshotInfo | null>
  describeScreen?: VerifyDeps['describeScreen']
  streamRound: VerifyDeps['streamRound']
}

export interface RoundsResult {
  held: string
  suppressed: boolean
  performedLines: string[]
  interrupted: boolean
  claimedDone: boolean
  confirmedOnScreen: boolean
  willVerify: boolean
  progress: ProgressGuard
}

export async function runAgentRounds(deps: RoundsDeps): Promise<RoundsResult | null> {
  const { abort, request, settings, canAct, apiKey, maxTokens, agent, publishAgent } = deps
  if (!deps.session || abort.signal.aborted) return null
  let { round, held, area } = deps
  let shot = deps.initialShot === undefined ? deps.session.snapshot.screenshot : deps.initialShot
  let suppressed = false
  let interrupted = false
  let claimedDone = false
  let confirmedOnScreen = false
  let observed = false
  let blockedRepeats = 0
  let recoveries = 0
  const performedLines: string[] = []
  const progress = new ProgressGuard()
  const willVerify = settings.agent.verifyResult && canAct && Boolean(area)
  const gone = (): boolean => abort.signal.aborted || !deps.session
  const fail = (message: string, answer = ''): void => {
    interrupted = true
    suppressed = !answer.trim()
    held = answer
    publishAgent({ phase: 'error', step: 0, total: 0, label: '', plan: [], message })
  }

  if (round.steps.length > 0 && (!canAct || !area)) {
    fail(canAct ? 'Неизвестно, где на экране цель — действие не выполнено.'
      : (agent.availability().reason ?? 'Агентный режим недоступен.'))
  }

  while (canAct && area && deps.session && deps.session.rounds < settings.agent.maxSteps) {
    if (gone()) return null
    const pending = normalizePlan(round.steps, { settings: settings.agent, area, prompt: request.prompt })
    if (pending.rejected.length) {
      fail(pending.rejected.map((entry) => entry.reason).join(' '))
      break
    }
    // A standalone verdict on the post-action frame can finish the turn.
    // A marker in a plan describes the screen before those actions run.
    const verdict = round.steps[0]?.action
    if (willVerify && observed && performedLines.length > 0 &&
      round.steps.length === 1 && verdict?.kind === 'done' && verdict.label?.trim()) {
      claimedDone = true
      confirmedOnScreen = true
      suppressed = !held.trim()
      break
    }
    const hasAction = pending.steps.length > 0
    if (!hasAction && !pending.wantsLook) {
      if (suppressed && !willVerify) {
        fail('Выполнение всей просьбы не подтверждено.', held)
      }
      break
    }
    deps.session.rounds += 1
    let feedback = ''
    let needsRecovery = false
    held = ''

    if (hasAction) {
      suppressed = true
      if (!progress.allow(pending.steps, shot)) {
        blockedRepeats += 1
        feedback = pending.steps.some((step) => step.action.kind === 'browser')
          ? 'Браузер уже открывали. Если он виден на снимке, продолжи в его интерфейсе: найди нужный сайт по названию.'
          : REPEATED_PLAN
        needsRecovery = true
        if (blockedRepeats >= 2) {
          fail('Агент повторно предложил ту же цепочку без прогресса. Результат не достигнут.')
          break
        }
      } else {
        const result = await agent.execute({
          requestId: request.requestId, prompt: request.prompt,
          steps: pending.steps, area, finished: pending.finished,
          verify: willVerify || pending.steps.some((step) => step.action.kind !== 'done'),
          skipped: pending.rejected.map((entry) => entry.reason)
        })
        if (gone()) return null
        for (const step of result.performed) {
          performedLines.push(step.ok ? step.label : `${step.label} (не удалось)`)
        }
        if (result.performed.some((step) => step.ok)) blockedRepeats = 0
        if (result.message) {
          // Only known targeting failures are recoverable. User stops,
          // permissions and unknown failures always return control.
          if (!result.recoverable) { interrupted = true; break }
          feedback = result.message
          needsRecovery = result.performed.length === 0
          performedLines.push(`Не выполнено: ${feedback}`)
        } else if (result.finished && result.performed.length === 0) {
          claimedDone = true
          held = round.text
          suppressed = !held.trim()
          break
        } else if (result.performed.length === 0) {
          break
        }
      }
    }

    if (needsRecovery && deps.session) {
      deps.session.rounds -= 1
      recoveries += 1
      trace('agent.recovery', { recoveries, maxRecoveries: MAX_RECOVERY_ROUNDS, rounds: deps.session.rounds })
      if (recoveries > MAX_RECOVERY_ROUNDS) {
        fail(feedback || 'Способы продолжить задачу исчерпаны.')
        break
      }
    }

    if (!deps.session || deps.session.rounds >= settings.agent.maxSteps) {
      trace('agent.budget', { rounds: deps.session?.rounds ?? 0, maxRounds: settings.agent.maxSteps, recoveries })
      if (!willVerify || performedLines.length === 0) {
        fail('Лимит этапов исчерпан. Выполнение всей просьбы не подтверждено.')
      }
      break
    }

    publishAgent({ phase: 'checking', step: 0, total: 0,
      label: feedback || 'Проверяю, что осталось сделать', plan: [] })
    // A failed capture must never supply the frame from before the action.
    shot = await deps.capture(deps.session)
    if (gone()) return null
    const image = shot && imagePart(shot.dataUrl)
    if (!shot || !image || !shot.area) {
      fail('Не удалось получить новый снимок экрана — продолжение остановлено.')
      break
    }
    area = shot.area
    let actionTargets: AxElementInfo[] | undefined
    const outline = await deps.describeScreen?.(area, (targets) => { actionTargets = targets }).catch(() => null)
    if (gone()) return null
    const continuation = buildContinue({
      performed: performedLines, prompt: request.prompt, round: deps.session!.rounds,
      canContinue: true, act: canAct, outline, feedback
    })
    const parts: ContentPart[] = [image, {
      type: 'text', text: withPreviousCommand(continuation.userText, deps.previousCommand)
    }]
    round = await deps.streamRound({
      messages: [
        { role: 'system', parts: [{ type: 'text', text: `${settings.systemPrompt.trim()}\n\n${continuation.modeInstruction}` }] },
        ...(deps.historyMessages ?? []),
        { role: 'user', parts }
      ],
      requestId: request.requestId, maxTokens, signal: abort.signal,
      canDraw: false, area, apiKey, holdText: true, actionTargets
    })
    if (gone()) return null
    held = round.text
    observed = true
  }

  return { held, suppressed, performedLines, interrupted, claimedDone, confirmedOnScreen, willVerify, progress }
}
