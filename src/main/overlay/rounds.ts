/** Agent plans and @look continuations; all effects are supplied by the turn. */
import type { AgentAvailability, AppSettings, ContextSnapshot, ScreenRect, SendRequest, ScreenshotInfo } from '@shared/types'
import { normalizePlan } from '../agent/plan'
import { imagePart } from '../imagePart'
import type { ContentPart } from '../llm/provider'
import { buildContinue } from '../prompt'
import type { RoundResult, VerifyDeps } from './verify'

export interface RoundSession {
  rounds: number
  snapshot: Pick<ContextSnapshot, 'screenshot'>
}

export interface RoundsDeps {
  /** A getter preserves the controller's live session after every await. */
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
  ensureFreshScreenshot: (session: RoundSession) => Promise<ScreenshotInfo | null>
  streamRound: VerifyDeps['streamRound']
}

export interface RoundsResult {
  held: string
  suppressed: boolean
  performedLines: string[]
  interrupted: boolean
  claimedDone: boolean
  willVerify: boolean
}

export async function runAgentRounds(deps: RoundsDeps): Promise<RoundsResult | null> {
  const { abort, request, settings, area, canAct, canDraw, apiKey, maxTokens,
    agent, publishAgent, ensureFreshScreenshot, streamRound } = deps
  let { round, held } = deps
  let suppressed = false
  if (!deps.session) return null

  // ---- agent rounds -------------------------------------------------
  //
  // A plan is executed after the stream ends, never during it: the model has
  // to finish describing what it is about to do before the screen moves under
  // the sentence it is still writing.
  let pending = normalizePlan(round.steps, { settings: settings.agent, area })

  // A plan means this turn is an action, not an answer: the narration held
  // above is dropped and the agent row becomes the only thing the card says.
  if (canAct && area && pending.steps.length > 0) {
    suppressed = true
    held = ''
  }

  // The model asked to press something but the tool was not offered (mode
  // off, no permission, no image). Its markers were stripped from the answer,
  // so without this the card would show a confident "нажимаю Экспорт" and
  // nothing would have happened — the worst kind of silence.
  if (round.steps.length > 0 && (!canAct || !area)) {
    publishAgent({
      phase: 'error',
      step: 0,
      total: round.steps.length,
      label: '',
      plan: round.steps.map((step) => step.label),
      message: canAct
        ? 'Неизвестно, где на экране цель — действие не выполнено.'
        : (agent.availability().reason ?? 'Агентный режим недоступен.')
    })
  }

  // A continuation is what the *model* asked for with `@look`, not a routine
  // second request. Most answers click one thing and stop; making every turn
  // look again would double the cost of the common case to serve the rare one.
  //
  // `performedLines` is what the whole turn did, gathered across every round
  // of it. It is written for the verification request below, which needs the
  // full list — a check that only knows about the last plan would judge a
  // half-finished sequence.
  const performedLines: string[] = []
  /**
   * Set when the runner stopped by itself: an abort, a missing permission, a
   * click that hit the wrong control. Such a turn is not verified — the card
   * already carries the reason, and a second opinion about a screen the user
   * deliberately interrupted is noise on top of an explanation.
   */
  let interrupted = false
  /**
   * Whether the model ended its plan with `@done`.
   *
   * Tracked separately from `performedLines` because the two disagree in the
   * case that most needs a check: a plan that claims success and presses
   * nothing. "Готово" with an empty list of actions is not a small claim, it
   * is the whole claim — and it is exactly what a screenshot can settle.
   */
  let claimedDone = false
  /**
   * Whether the result of a plan will be judged on a fresh screenshot.
   *
   * Known before the first plan runs, and passed down to every one of them:
   * the runner announces the end of a plan with «Готово», and in a turn that
   * ends with a check that word would be spoken before the evidence exists.
   * It is what the check is about — see `request.verify` on the runner side.
   */
  const willVerify = settings.agent.verifyResult && canAct && Boolean(area)

  while (
    (pending.steps.length > 0 || pending.wantsLook) &&
    deps.session.rounds < settings.agent.maxSteps
  ) {
    if (!canAct || !area) break

    const hasAction = pending.steps.length > 0
    if (hasAction) {
      // Something is about to move on screen. Whatever the round wrote about
      // it is narration, not the result: the agent row reports what happened.
      suppressed = true
      held = ''
    }

    const result =
      hasAction
        ? await agent.execute({
            requestId: request.requestId,
            prompt: request.prompt,
            steps: pending.steps,
            area,
            finished: pending.finished,
            verify: willVerify,
            // Steps the plan asked for and the rules refused. They are shown
            // in the card rather than swallowed: a user who reads "нажимаю
            // Экспорт" and sees nothing happen would blame the app, not the
            // missing keystroke.
            skipped: pending.rejected.map((entry) => entry.reason)
          })
        : { finished: false, performed: [] }
    if (abort.signal.aborted || !deps.session) return null

    // Collected before any `break`: whatever ends the loop, the check below
    // has to know what the screen was asked to become.
    for (const step of result.performed) {
      performedLines.push(step.ok ? step.label : `${step.label} (не удалось)`)
    }
    // A message means the plan stopped early — a wrong target, a missing
    // permission, or "стоп" from the user — and none of those is a result to
    // check. The card already says why, and a screenshot verdict on top of it
    // would be a second, unrelated opinion.
    if (result.message) interrupted = true
    if (result.finished) claimedDone = true

    // `@done` — or a refusal to continue — ends the turn: there is nothing
    // left to look at, and asking again would just spend tokens to hear "да".
    if (result.finished || result.message || interrupted) break
    // An aborted run means the user took the mouse back. Looking again would
    // immediately take it away from them a second time. A plan that only
    // asked to look has no actions to have been interrupted, so it passes.
    if (hasAction && result.performed.length === 0) break
    // Nothing asked to look again: the turn is over.
    if (!pending.wantsLook) break

    deps.session.rounds += 1
    const canContinue = deps.session.rounds < settings.agent.maxSteps
    if (!canContinue) break

    // The screen is a different place now, so the picture has to be re-taken:
    // continuing to reason about the old frame is exactly how an agent clicks
    // the same button twice.
    await ensureFreshScreenshot(deps.session)
    if (abort.signal.aborted || !deps.session) return null
    const freshArea = deps.session.snapshot.screenshot?.area ?? area
    const shot = deps.session.snapshot.screenshot
    const continuation = buildContinue({
      performed: result.performed.map((step) =>
        step.ok ? step.label : `${step.label} (не удалось)`
      ),
      prompt: request.prompt,
      round: deps.session.rounds,
      canContinue: deps.session.rounds + 1 < settings.agent.maxSteps,
      act: canAct
    })

    const continueParts: ContentPart[] = []
    if (shot) {
      const image = imagePart(shot.dataUrl)
      if (image) continueParts.push(image)
    }
    continueParts.push({ type: 'text', text: continuation.userText })

    round = await streamRound({
      messages: [
        {
          role: 'system',
          parts: [
            {
              type: 'text',
              text: `${settings.systemPrompt.trim()}\n\n${continuation.modeInstruction}`
            }
          ]
        },
        { role: 'user', parts: continueParts }
      ],
      requestId: request.requestId,
      maxTokens,
      signal: abort.signal,
      canDraw,
      area: freshArea,
      apiKey,
      // Only the *result* of a continuation is an answer. Holding it means a
      // second plan can still replace it with the action row.
      holdText: true
    })
    if (abort.signal.aborted || !deps.session) return null
    held += round.text

    pending = normalizePlan(round.steps, { settings: settings.agent, area: freshArea })
    if (canAct && area && pending.steps.length > 0) {
      suppressed = true
      held = ''
    }
  }

  return { held, suppressed, performedLines, interrupted, claimedDone, willVerify }
}
