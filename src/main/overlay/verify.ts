/**
 * The verification round: «сверь просьбу с тем, что видно на экране».
 *
 * The word «Готово» is a promise about the screen, and up to this point every
 * promise in a turn came from the model's opinion about a screenshot that its own
 * clicks have since invalidated. So before the card is allowed to say it, the
 * screen is photographed again and the model is asked one question it cannot
 * answer from its own narration.
 *
 * This used to be a 159-line closure inside `send()`, reading eleven values from
 * the surrounding scope and mutating three of them (`performedLines`, `suppressed`,
 * `held`). The eleven are arguments now. Of the three mutations, one stays here
 * (the correction's steps are part of what the check learned) and two go back to
 * the caller as a result — `suppressed`/`held` are invariants of the *turn*, not of
 * the check, and the turn is the thing that knows what to do with them.
 *
 * Every side effect is passed in, so the decision can be tested without a window,
 * a provider or a helper: `capture()`, `streamRound()`, `execute()`,
 * `publishAgent()` and `delay()`.
 */

import type {
  AgentEvent,
  AxElementInfo,
  ScreenRect,
  AgentPlanStep,
  AgentRunRequest,
  AppSettings,
  ScreenshotInfo
} from '@shared/types'
import type { AgentRunResult } from '../agent'
import { normalizePlan } from '../agent/plan'
import { readVerdict } from '../agent/verdict'
import { ProgressGuard, REPEATED_PLAN } from '../agent/progress'
import { imagePart } from '../imagePart'
import type { ChatMessage, ContentPart } from '../llm/provider'
import { buildVerify, withPreviousCommand } from '../prompt'

/**
 * How many verification requests one turn may spend.
 *
 * Two is "посмотреть, и если не вышло — исправить и посмотреть ещё раз". A third
 * would be an agent loop the user never asked for, and by then the honest answer
 * is the screenshot itself: "не получилось, вот что на экране" beats a third
 * guess about why.
 */
export const MAX_CHECKS = 2
const MAX_PENDING_RECHECKS = 4
const PENDING_RECHECK_MS = 3_000

/**
 * Pause before the verification screenshot, in ms.
 *
 * A menu is drawn after the click that opened it, a list re-sorts after the
 * keystroke that filtered it. Photographing the screen in the same millisecond
 * catches a half-open panel, and the check then reports a failure that is really
 * a frame taken too early — worse than no check at all, because it is confident.
 */
export const VERIFY_SETTLE_MS = 320

/**
 * Whether this turn needs a check at all.
 *
 * Three things have to agree, and each is a different reason to skip:
 *
 * - `willVerify` — the runner was told to withhold «Готово» precisely because the
 *   caller is going to check. Using the same answer here is what keeps the two
 *   from disagreeing: exactly the turns that withheld the word get checked.
 * - `interrupted` — the card already explains why the action stopped, and a
 *   verdict about a screen the user deliberately took back is noise.
 * - something actually ran (or was claimed): a text-only answer has no claim about
 *   the screen, so there is nothing to photograph.
 */
export function shouldVerify(options: {
  willVerify: boolean
  interrupted: boolean
  performed: number
  claimedDone: boolean
}): boolean {
  return (
    options.willVerify && !options.interrupted && (options.performed > 0 || options.claimedDone)
  )
}

/** What one round of the model returned, as the caller knows it. */
export interface RoundResult {
  steps: AgentPlanStep[]
  text: string
}

export interface VerifyDeps {
  settings: AppSettings
  requestId: string
  prompt: string
  apiKey: string
  maxTokens: number
  /** What the plan did, in order; the correction's steps are appended to it. */
  performedLines: string[]
  historyMessages?: ChatMessage[]
  previousCommand?: string
  progress?: ProgressGuard
  signal: AbortSignal
  /** False once the turn is gone (the session was closed or superseded). */
  isAlive: () => boolean
  publishAgent: (event: AgentEvent) => void
  /** A screenshot taken now. `null` when the screen could not be captured. */
  capture: () => Promise<ScreenshotInfo | null>
  describeScreen?: (area: ScreenRect, onTargets: (elements: AxElementInfo[]) => void) => Promise<string | null>
  streamRound: (options: {
    messages: ChatMessage[]
    requestId: string
    maxTokens: number
    signal: AbortSignal
    canDraw: boolean
    area: ScreenshotInfo['area'] | null
    apiKey: string
    holdText: boolean
    actionTargets?: AxElementInfo[]
  }) => Promise<RoundResult>
  execute: (request: AgentRunRequest & { skipped?: string[] }) => Promise<AgentRunResult>
  /** The phase the runner last published, for "did the user stop the correction". */
  lastPhase: () => string
  delay: (ms: number) => Promise<void>
}

/**
 * What the check concluded.
 *
 * - `confirmed` — the screen shows what the plan claimed.
 * - `unconfirmed` — the model looked and said no; `evidence` is what it saw, and
 *   that text becomes the answer instead of a status word.
 * - `not-run` — it never got to look (no key, no screenshot, aborted). A missing
 *   screenshot must not be reported as either outcome.
 */
export type VerifyOutcome = 'confirmed' | 'unconfirmed' | 'pending' | 'not-run'

export interface VerifyResult {
  outcome: VerifyOutcome
  /** The check's report for the user, separate from the verdict marker. */
  evidence: string
}

/**
 * Runs the check and reports what it found.
 *
 * `deps.performedLines` is mutated in place: a correction that ran is part of what
 * the turn did, and the caller's list is the one that ends up in the continuation
 * prompt.
 */
export async function verifyResult(deps: VerifyDeps): Promise<VerifyResult> {
  const notRun = (): VerifyResult => ({ outcome: 'not-run', evidence: '' })

  // Re-stated here because the caller's guard narrows `apiKey` outside this
  // function only; without a key the check cannot run, and that is not the same
  // statement as "the request is not fulfilled".
  if (!deps.isAlive() || !deps.apiKey) return notRun()
  const gone = (): boolean => deps.signal.aborted || !deps.isAlive()

  let evidence = ''
  let correctionFeedback = ''
  let replanned = false
  let pendingRechecks = 0
  let waiting = false
  const progress = deps.progress ?? new ProgressGuard()

  /**
   * Ends the check when the turn was cancelled under it.
   *
   * Escape, a new question and closing the card all arrive as an abort, and none
   * of them has a plan to stop — there is nothing moving, only a request in
   * flight. Without this the row would keep saying "проверяю" over a request that
   * will never answer.
   */
  const bail = (): VerifyResult => {
    if (deps.isAlive()) {
      deps.publishAgent({
        phase: 'aborted',
        step: 0,
        total: 0,
        label: '',
        plan: [],
        message: 'Проверка остановлена.'
      })
    }
    return notRun()
  }

  let check = 1
  while (check <= MAX_CHECKS) {
    if (check > 1 && !waiting) {
      // A correction ran, so the screen moved again: the row goes back to
      // "проверяю" for the second look instead of keeping the fix's own
      // "Выполнено" — which is the exact sentence under test.
      deps.publishAgent({
        phase: 'checking',
        step: 0,
        total: 0,
        label: 'Проверяю по экрану, выполнена ли просьба',
        plan: []
      })
    }
    // A forced capture, not `ensureFreshScreenshot`: that helper happily reuses a
    // shot younger than 600 ms, and the shot it would reuse was taken *while the
    // plan was running*. The whole question here is what the screen looks like
    // after the last action, so the delay is part of the answer and the picture
    // has to be a new one.
    await deps.delay(waiting ? PENDING_RECHECK_MS : VERIFY_SETTLE_MS)
    waiting = false
    if (gone()) return bail()
    const shot = await deps.capture()
    if (gone()) return bail()
    if (!shot || !shot.area) {
      deps.publishAgent({
        phase: 'error',
        step: 0,
        total: 0,
        label: '',
        plan: [],
        message: 'Не удалось посмотреть на экран — результат не проверен.'
      })
      return notRun()
    }

    const freshArea = shot.area
    const canFix = check < MAX_CHECKS
    let actionTargets: AxElementInfo[] | undefined
    const outline = canFix
      ? await deps.describeScreen?.(freshArea, (targets) => { actionTargets = targets }).catch(() => null)
      : null
    if (gone()) return bail()
    const checkRequest = buildVerify({
      performed: deps.performedLines,
      prompt: deps.prompt,
      // The last check may not act: a fix it invents would be executed with no
      // chance to look at the result, which is the blind click this whole
      // mechanism exists to prevent. It reports instead.
      canFix,
      outline,
      feedback: correctionFeedback
    })

    const parts: ContentPart[] = []
    const image = imagePart(shot.dataUrl)
    if (!image) {
      deps.publishAgent({ phase: 'error', step: 0, total: 0, label: '', plan: [],
        message: 'Не удалось прочитать снимок — результат не проверен.' })
      return notRun()
    }
    parts.push(image)
    parts.push({ type: 'text', text: withPreviousCommand(checkRequest.userText, deps.previousCommand) })

    // A new local name on purpose: the caller's `round` holds the plan's answer
    // and is still read after this block, so a verdict must not overwrite it.
    const verdict = await deps.streamRound({
      messages: [
        {
          role: 'system',
          parts: [
            {
              type: 'text',
              text: `${deps.settings.systemPrompt.trim()}\n\n${checkRequest.modeInstruction}`
            }
          ]
        },
        ...(deps.historyMessages ?? []),
        { role: 'user', parts }
      ],
      requestId: deps.requestId,
      maxTokens: deps.maxTokens,
      signal: deps.signal,
      // Drawing has no place in a check: an arrow painted over the result would
      // be photographed into the next frame and read as part of the interface.
      canDraw: false,
      area: freshArea,
      apiKey: deps.apiKey,
      // Hold the text until we know whether this is a final report or a plan
      // for another correction.
      holdText: true,
      actionTargets
    })
    if (gone()) return bail()
    evidence = verdict.text

    if (verdict.steps.length === 1 && verdict.steps[0].action.kind === 'look') {
      if (pendingRechecks >= MAX_PENDING_RECHECKS) {
        return { outcome: 'pending', evidence: 'Последний снимок всё ещё показывает промежуточное состояние. Результат пока не подтверждён.' }
      }
      pendingRechecks += 1
      deps.publishAgent({
        phase: 'checking', step: 0, total: 0,
        label: 'Жду, пока экран обновится…', plan: []
      })
      waiting = true
      continue
    }

    const plan = normalizePlan(verdict.steps, {
      settings: deps.settings.agent,
      area: freshArea,
      prompt: deps.prompt
    })
    const answer = readVerdict(plan, { canFix: check < MAX_CHECKS })

    // A pass needs nothing else: the screen was seen and the claim matches it.
    if (answer.kind === 'confirmed') return { outcome: 'confirmed', evidence }
    // Not done, and the answer explains what is on screen instead of claiming
    // otherwise. Those words are the reply the user gets.
    if (answer.kind === 'unconfirmed') break

    if (!progress.allow(answer.actions, shot)) {
      evidence = REPEATED_PLAN
      break
    }

    const fix = await deps.execute({
      requestId: deps.requestId,
      prompt: deps.prompt,
      steps: answer.actions,
      area: freshArea,
      finished: false,
      // The correction is judged the same way: it does not get to declare itself
      // done, the second look does.
      verify: true,
      skipped: plan.rejected.map((entry) => entry.reason)
    })
    if (gone()) return bail()
    for (const step of fix.performed) {
      deps.performedLines.push(step.ok ? step.label : `${step.label} (не удалось)`)
    }
    if (fix.message || fix.performed.length === 0) {
      // A correction stopped by the user is not a verdict: they ended the turn
      // themselves and the runner has already published the reason. Reporting
      // "не выполнено" over it would blame the result for a decision that was
      // theirs.
      if (deps.lastPhase() === 'aborted') return notRun()
      if (fix.recoverable && fix.message && fix.performed.length === 0) {
        evidence = fix.message
        if (!replanned) {
          replanned = true
          correctionFeedback = fix.message
          deps.publishAgent({ phase: 'checking', step: 0, total: 0, label: fix.message, plan: [] })
          continue
        }
      }
      // A fix that broke off stops the checks: the card already explains why, and
      // another screenshot would just re-take the same broken screen.
      break
    }
    correctionFeedback = ''
    check += 1
  }

  // The turn ends unverified. The check's words are the answer: what is actually
  // on the screen, described by the model that just looked at it. That is a better
  // reply than a status word about a claim nobody could confirm — and it is the
  // only honest thing to say, because the card is about to show a red row saying
  // exactly this.
  return { outcome: 'unconfirmed', evidence }
}
