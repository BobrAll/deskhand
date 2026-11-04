/** Observe → act → observe, preserving the goal and every attempt for the turn. */
import type { AgentAvailability, AppSettings, ContextSnapshot, ScreenRect, SendRequest, ScreenshotInfo } from '@shared/types'
import { normalizePlan } from '../agent/plan'
import { ProgressGuard, REPEATED_PLAN } from '../agent/progress'
import { imagePart } from '../imagePart'
import type { ContentPart } from '../llm/provider'
import { buildContinue } from '../prompt'
import type { RoundResult, VerifyDeps } from './verify'

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
  round: RoundResult
  held: string
  agent: {
    execute: VerifyDeps['execute']
    availability: () => AgentAvailability
  }
  publishAgent: VerifyDeps['publishAgent']
  /** Must capture after the actions; never fall back to a cached frame. */
  capture: (session: RoundSession) => Promise<ScreenshotInfo | null>
  describeScreen?: (area: ScreenRect) => Promise<string | null>
  streamRound: VerifyDeps['streamRound']
}

export interface RoundsResult {
  held: string
  suppressed: boolean
  performedLines: string[]
  interrupted: boolean
  claimedDone: boolean
  willVerify: boolean
  progress: ProgressGuard
}

export async function runAgentRounds(deps: RoundsDeps): Promise<RoundsResult | null> {
  const { abort, request, settings, canAct, apiKey, maxTokens, agent, publishAgent } = deps
  if (!deps.session || abort.signal.aborted) return null
  let { round, held, area } = deps
  let shot = deps.session.snapshot.screenshot
  let suppressed = false
  let interrupted = false
  let claimedDone = false
  let blockedRepeats = 0
  const performedLines: string[] = []
  const progress = new ProgressGuard()
  const willVerify = settings.agent.verifyResult && canAct && Boolean(area)
  const gone = (): boolean => abort.signal.aborted || !deps.session
  const fail = (message: string): void => {
    interrupted = true
    suppressed = true
    held = ''
    publishAgent({ phase: 'error', step: 0, total: 0, label: '', plan: [], message })
  }

  if (round.steps.length > 0 && (!canAct || !area)) {
    fail(canAct ? 'Неизвестно, где на экране цель — действие не выполнено.'
      : (agent.availability().reason ?? 'Агентный режим недоступен.'))
  }

  while (canAct && area && deps.session && deps.session.rounds < settings.agent.maxSteps) {
    if (gone()) return null
    const pending = normalizePlan(round.steps, { settings: settings.agent, area })
    if (pending.rejected.length) {
      fail(pending.rejected.map((entry) => entry.reason).join(' '))
      break
    }
    const hasAction = pending.steps.length > 0
    if (!hasAction && !pending.wantsLook) {
      if (suppressed && !willVerify) {
        fail(round.text.trim() || 'Выполнение всей просьбы не подтверждено.')
      }
      break
    }
    deps.session.rounds += 1
    let feedback = ''

    if (hasAction) {
      suppressed = true
      held = ''
      if (!progress.allow(pending.steps, shot)) {
        blockedRepeats += 1
        feedback = REPEATED_PLAN
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
        if (result.message) {
          // Only known targeting failures are recoverable. User stops,
          // permissions and unknown failures always return control.
          if (!result.recoverable) { interrupted = true; break }
          feedback = result.message
          performedLines.push(`Не выполнено: ${feedback}`)
        } else if (result.finished && result.performed.length === 0) {
          claimedDone = true
          break
        } else if (result.performed.length === 0) {
          break
        }
      }
    }

    if (!deps.session || deps.session.rounds >= settings.agent.maxSteps) {
      if (!willVerify || performedLines.length === 0) {
        fail('Лимит этапов исчерпан. Выполнение всей просьбы не подтверждено.')
      }
      break
    }

    publishAgent({ phase: 'checking', step: 0, total: 0,
      label: feedback ? 'Проверяю экран и меняю способ' : 'Проверяю, что осталось сделать', plan: [] })
    // A failed capture must never supply the frame from before the action.
    shot = await deps.capture(deps.session)
    if (gone()) return null
    const image = shot && imagePart(shot.dataUrl)
    if (!shot || !image || !shot.area) {
      fail('Не удалось получить новый снимок экрана — продолжение остановлено.')
      break
    }
    area = shot.area
    const outline = await deps.describeScreen?.(area).catch(() => null)
    if (gone()) return null
    const continuation = buildContinue({
      performed: performedLines, prompt: request.prompt, round: deps.session!.rounds,
      canContinue: true, act: canAct, outline, feedback
    })
    const parts: ContentPart[] = [image, { type: 'text', text: continuation.userText }]
    round = await deps.streamRound({
      messages: [
        { role: 'system', parts: [{ type: 'text', text: `${settings.systemPrompt.trim()}\n\n${continuation.modeInstruction}` }] },
        { role: 'user', parts }
      ],
      requestId: request.requestId, maxTokens, signal: abort.signal,
      canDraw: false, area, apiKey, holdText: true
    })
    if (gone()) return null
    held += round.text
  }

  return { held, suppressed, performedLines, interrupted, claimedDone, willVerify, progress }
}
