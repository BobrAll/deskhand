import type { AgentActionRow, AgentEvent, AgentToolRequest } from '@shared/types'
import { getSettings, patchSettings } from '../settings/store'
import { classifyCall, describeCall, rememberKey } from './approval'
import type { RunEventState } from './runEvents'
import { trace } from './trace'

/**
 * A question nobody answers must not hang the run.
 *
 * Long enough that a user who walked away can come back and answer it, short
 * enough that a forgotten card does not leave a click-through window on screen
 * for the rest of the day. The agent has its own ceiling; this one is the host's.
 */
const APPROVAL_TIMEOUT_MS = 5 * 60_000

/**
 * How long after an approval the mouse is allowed to move without stopping the run.
 *
 * The hand is already on the mouse when it answers the question, and letting go of
 * the button moves it a few points. Without this grace, the run the user just
 * allowed would stop on the way back to the keyboard.
 */
const APPROVAL_MOUSE_GRACE_MS = 1_200

/**
 * How long the native watcher ignores an Escape that belongs to a refusal.
 *
 * Denying a question and stopping the run are both "Escape". The renderer's
 * keydown denies the question, and the same keystroke reaches the native watcher;
 * this window is just long enough to let that second copy arrive and be ignored.
 * It is not used for an approval: Escape after "Разрешить" is a new decision.
 */
const APPROVAL_ESCAPE_GRACE_MS = 200

/**
 * Why a question was refused, in the two languages it has to be said in.
 *
 * The same decision reaches two readers: the card, which speaks Russian to the
 * user, and the model, which receives the refusal as a tool result and reads
 * English (`AGENTS.md`, "Copy and tone"). Keeping both sentences in one value
 * is what stops them from drifting apart.
 */
interface Refusal {
  /** What the card shows: Russian, «ты». */
  label: string
  /** What the agent gets as the tool result: English, like all model-facing text. */
  reason: string
}

/**
 * The user said no to the call the agent is blocked on.
 *
 * Not a stop: the agent receives the refusal as a failed call and takes another
 * step, so the run is still alive. The card's sentence names the one thing that
 * happened instead of claiming the whole run ended.
 */
const REFUSED: Refusal = {
  label: 'Действие отклонено.',
  reason: 'The user declined the action.'
}

/** Nobody answered the question before the host's ceiling. */
const NOT_CONFIRMED: Refusal = {
  label: 'Подтверждение не получено.',
  reason: 'The action was not confirmed by the user.'
}

/**
 * What the agent is told when the user stops the run on a pending question.
 *
 * Model-facing, so English: this string becomes the tool result the model reads
 * on its next step, and text the model reads is English by contract. The card's
 * own sentence is the `message` `stop()` publishes.
 */
const CANCELLED_REASON = 'The run was cancelled by the user.'

type PendingApproval = {
  request: AgentToolRequest
  timer: ReturnType<typeof setTimeout>
  settle(allow: boolean, remember: boolean, refusal?: Refusal): void
}

interface ApprovalPromptHost {
  currentRun(): Pick<RunEventState, 'actions' | 'step' | 'total'> | null
  approve(id: string, allow: boolean, reason?: string): void
  publish(event: Partial<AgentEvent> & Pick<AgentEvent, 'phase'>): void
  actionRows(): AgentActionRow[]
  lastLabel(): string
  setPassthrough(active: boolean): void
  focus(): void
  hasFocus(): boolean | undefined
}

export function createApprovalPrompt({
  currentRun,
  approve,
  publish,
  actionRows,
  lastLabel,
  setPassthrough,
  focus,
  hasFocus
}: ApprovalPromptHost) {
  let pending: PendingApproval | null = null
  /** Mouse movements before this instant belong to the answer, not to a stop. */
  let ignoreMouseUntil = 0
  /** The same for the Escape that the renderer may have handled already. */
  let ignoreEscapeUntil = 0

  function clearPending(): void {
    if (!pending) return
    clearTimeout(pending.timer)
    pending = null
  }

  function resetGrace(): void {
    ignoreMouseUntil = 0
    ignoreEscapeUntil = 0
  }

  function cancel(): void {
    resetGrace()
    const request = pending?.request
    clearPending()
    if (request) approve(request.id, false, CANCELLED_REASON)
  }

  function consumeAbort(reason: 'mousemove' | 'escape'): boolean {
    // Reaching for the answer is not taking control back. A question makes the
    // card clickable, and the hand on the mouse is on its way to «Разрешить»;
    // stopping the run there was the bug.
    if (reason === 'mousemove' && (pending || Date.now() < ignoreMouseUntil)) return true
    // An open question owns Escape. The focused card answers it itself; only
    // when the user clicked away does the native watcher answer, so Escape
    // cannot be swallowed by the app behind the question.
    if (reason === 'escape' && pending) {
      if (hasFocus() !== false) return true
      pending.settle(false, false, REFUSED)
      return true
    }
    // The renderer may have answered the question a moment ago; its keydown
    // reaches us in the same keystroke.
    if (reason === 'escape' && Date.now() < ignoreEscapeUntil) return true
    return false
  }

  /**
   * Answers the pending question.
   *
   * Called from the card through IPC. Idempotent on purpose: a second click on
   * a button that was already handled, or an Escape arriving in the same tick
   * as an answer, must not decide twice.
   */
  function answer(id: string, allow: boolean, remember: boolean): void {
    if (!pending || pending.request.id !== id) return
    pending.settle(allow, remember)
  }

  /**
   * Puts one question in front of the user and blocks the agent until answered.
   *
   * The card is made clickable for exactly as long as the question is open, and
   * the agent is already blocked on the pipe — so nothing can be clicked behind
   * the panel while the user is deciding.
   */
  function ask(request: AgentToolRequest): void {
    const active = currentRun()
    if (!active || pending) return
    const decision = classifyCall(request, getSettings().agent.rememberedApprovals)
    if (decision.kind === 'allow') {
      approve(request.id, true)
      return
    }
    if (decision.kind === 'deny') {
      trace('agent.approval', { outcome: 'denied' })
      // The model reads `reason` as a tool result, so it is English; the row the
      // card lists keeps the user's language.
      approve(request.id, false, decision.reason)
      active.actions.push({ tool: request.tool, label: decision.label, ok: false })
      publish({ phase: 'acting', actions: actionRows(), code: 'secret' })
      return
    }

    trace('agent.approval', { outcome: 'asked', tool: request.tool })
    setPassthrough(false)
    // The card is clickable now; the keyboard should reach the answer too.
    focus()
    const settle = (allow: boolean, remember: boolean, refusal: Refusal = REFUSED): void => {
      if (!pending || pending.request.id !== request.id) return
      clearPending()
      // Leaving the button moves the mouse; neither answer should turn that into
      // a stop before the run has had a chance to act on the decision. Only a
      // refusal shares its keystroke with the native watcher: the same Escape
      // denies the question here and must not also stop the run that refusal
      // already ended. An approval comes from Enter or a click, so an Escape
      // after it is a new decision and stops the run.
      ignoreMouseUntil = Date.now() + APPROVAL_MOUSE_GRACE_MS
      ignoreEscapeUntil = allow ? 0 : Date.now() + APPROVAL_ESCAPE_GRACE_MS
      if (allow && remember && request.fingerprint) {
        // Stored as a digest, not as the agent's readable fingerprint: the
        // settings file keeps a fixed-size, opaque list, and the readable form
        // stays in the trace where it is useful.
        const key = rememberKey(request.fingerprint)
        const agent = getSettings().agent
        if (!agent.rememberedApprovals.includes(key)) {
          patchSettings({
            agent: { ...agent, rememberedApprovals: [...agent.rememberedApprovals, key] }
          })
        }
      }
      approve(request.id, allow, allow ? undefined : refusal.reason)
      // The panel had the mouse and the focus for a moment; the agent's next
      // click must not land on it. That is true of a refusal as much as of an
      // allow: the agent turns the refusal into a failed call and takes another
      // step, so the run — and its clicks — continue either way.
      setPassthrough(true)
      // A refusal is not `aborted`: nothing stopped. The run goes on, so a
      // terminal phase here would say "stopped" over work that is still
      // happening — and leave the card in front of the window the agent was
      // about to press.
      publish({
        phase: 'acting',
        approval: null,
        label: allow ? lastLabel() : refusal.label,
        actions: actionRows()
      })
    }
    const timer = setTimeout(() => {
      trace('agent.approval', { outcome: 'timeout', tool: request.tool })
      settle(false, false, NOT_CONFIRMED)
    }, APPROVAL_TIMEOUT_MS)
    pending = { request, timer, settle }

    publish({
      phase: 'asking',
      step: active.step,
      total: active.total,
      label: describeCall(request),
      actions: actionRows(),
      approval: request,
      message: decision.detail
    })
  }

  return { ask, answer, clearPending, resetGrace, cancel, consumeAbort }
}
