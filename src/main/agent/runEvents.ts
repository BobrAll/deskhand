import type { AgentActionRow, AgentEvent, AgentPresentation, AgentRunResult, AgentToolRequest } from '@shared/types'
import { describeCall } from './approval'
import type { AgentSidecarEvent, AgentToolTiming } from './sidecar'
import { trace } from './trace'

export interface RunEventState {
  actions: AgentActionRow[]
  step: number
  total: number
  /** Labels captured when a tool starts, paired with its result later. */
  callLabels: Array<{ step: number; name: string; label: string }>
  /**
   * Why the loop gave up, when it did.
   *
   * The agent reports a stop and then ends the run anyway, so the two events
   * arrive in that order: a run that hit its step budget still produces a
   * `done` carrying the loop's last sentence. Without remembering the stop,
   * that `done` is indistinguishable from success — and the card drew a green
   * checkmark over a task it had not finished.
   */
  stopped: string | null
  /**
   * What the loop warned about but worked around.
   *
   * Kept for the same reason as `stopped`: the warning arrives mid-run, and the
   * host asks once at the end. Unlike `stopped` it does not colour the verdict —
   * the run went on, so its answer is still an answer.
   */
  notice: string | null
  /**
   * Whether the first streamed prose of this run has been traced.
   *
   * One event per run, not per delta: the point is the time to first token,
   * and a trace that records every word turns a 3-second step into a thousand
   * lines nobody reads.
   */
  firstToken: boolean
}

interface RunEventHost {
  publish(event: Partial<AgentEvent> & Pick<AgentEvent, 'phase'>): void
  publishProse(text: string, step: number, total: number): void
  actionRows(): AgentActionRow[]
  present(action: AgentPresentation): void
  ask(request: AgentToolRequest): void
  settleRun(result: AgentRunResult): void
  lastLabel(): string
}

/**
 * Milliseconds, at one decimal.
 *
 * Not integers: most tool calls take a fraction of a millisecond, and rounding
 * them to 0 would make the cheap path look free — which is exactly the wrong
 * lesson to draw from a trace when a 476 ms tree walk sits next to it.
 */
function ms(value: number): number {
  return Math.round(value * 10) / 10
}

/** A phase's share of a total, as a whole percent; null when the total is 0. */
function share(part: number, total: number): number | null {
  return total > 0 ? Math.round((part / total) * 100) : null
}

/** The same rounding, applied to the phases a tool call may have reported. */
function roundedTiming(timing: AgentToolTiming): Record<string, number> {
  const fields: Record<string, number> = {}
  if (timing.wallMs !== undefined) fields.wallMs = ms(timing.wallMs)
  if (timing.treeMs !== undefined) fields.treeMs = ms(timing.treeMs)
  if (timing.captureMs !== undefined) fields.captureMs = ms(timing.captureMs)
  if (timing.encodeMs !== undefined) fields.encodeMs = ms(timing.encodeMs)
  if (timing.imageBytes !== undefined) fields.imageBytes = timing.imageBytes
  return fields
}

/**
 * A Russian noun in the form the number demands.
 *
 * `3 шага` and `8 шагов` are the same sentence with different endings, and a
 * message that gets it wrong reads as broken at exactly the moment the user is
 * trying to work out whether to trust the failure.
 */
function plural(count: number, one: string, few: string, many: string): string {
  const mod10 = count % 10
  const mod100 = count % 100
  if (mod10 === 1 && mod100 !== 11) return one
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few
  return many
}

/**
 * The reasons the loop gives for ending a run without finishing it, as the
 * substrings it writes them with.
 *
 * The loop's diagnostics are English sentences assembled in Swift
 * ("the step budget ran out", "the model's reply was cut off at the token
 * limit"), and they are matched here rather than compared whole because each
 * one carries the numbers of the run it happened in. These strings are the
 * contract with the loop: change them only together with the Swift side.
 *
 * There are exactly three: `AgentLoop.finishRun` is the only caller of
 * `loopStopped`, and it has three call sites. A repeated call is not one of
 * them — the guard warns and lets the run continue (`loopWarned`), so a run
 * that repeats itself either recovers or ends on one of these.
 */
const STOP_BUDGET = 'budget'
const STOP_TOKEN_LIMIT = 'token limit'
const STOP_RETURNING_TO_SCREEN = 'returning to a screen'

/**
 * The fallback reason for a run that ended unfinished without saying why.
 *
 * Not one of the loop's diagnostics: it never sends this. It exists so a `done`
 * that contradicts itself — not complete, no stop event before it — is still
 * explained to the user rather than drawn as a success.
 */
const UNKNOWN_STOP = 'incomplete'

/**
 * Why the run ended without finishing, in the user's language.
 *
 * The loop's reasons are its own English diagnostics ("the step budget ran
 * out"), written for a log rather than for a person. Passing them through would
 * put a sentence about budgets in front of someone who asked to send a message —
 * and the loop's closing sentence on this path ("Stopped after 3 steps without
 * finishing the task") is worse still, because it reads like an answer.
 */
function stopMessage(reason: string, total: number): string {
  if (reason.includes(STOP_BUDGET)) {
    return (
      `Не успел за ${total} ${plural(total, 'шаг', 'шага', 'шагов')} — задача осталась ` +
      'невыполненной. Увеличь лимит шагов в настройках или уточни запрос.'
    )
  }
  if (reason.includes(STOP_TOKEN_LIMIT)) {
    // Not the same problem as running out of steps: the run had budget left, but
    // every answer was cut in half, so the model never got to say what it wanted
    // to do. Raising the step limit would not help — the fix is the output
    // length.
    return (
      'Остановился: ответ модели обрывался по лимиту длины. Увеличь максимум ' +
      'токенов в настройках — задача осталась невыполненной.'
    )
  }
  if (reason.includes(STOP_RETURNING_TO_SCREEN)) {
    // Not the same as a repeated call: the run tried different things and kept
    // arriving at the same screen. Raising the step limit would only buy more of
    // the same, so the honest answer names the loop instead.
    return (
      'Остановился: несколько шагов подряд экран не менялся — задача пошла по кругу. ' +
      'Задача осталась невыполненной.'
    )
  }
  return 'Задача осталась невыполненной.'
}

/** One event from the agent, as the card sees it. */
export function handleRunEvent(
  active: RunEventState,
  event: AgentSidecarEvent,
  { publish, publishProse, actionRows, present, ask, settleRun, lastLabel }: RunEventHost
): void {
  switch (event.kind) {
    case 'ready':
      return
    case 'step':
      active.step = event.step
      active.total = event.total || active.total
      trace('agent.step', { step: event.step, total: active.total })
      publish({
        phase: 'acting',
        step: event.step,
        total: active.total,
        label: lastLabel() || 'Работаю',
        actions: actionRows()
      })
      return
    case 'stream':
      // The same caption `publishProse` draws for the narration, but while the
      // model is still writing it. This is what turns the first two seconds of
      // every step from a spinner into the model's own words.
      if (event.text.trim()) {
        if (!active.firstToken) {
          active.firstToken = true
          trace('agent.firstToken', { step: active.step, chars: event.text.length })
        }
        publishProse(event.text, active.step, active.total)
      }
      return
    case 'narration':
      // The model's own sentence about what it is doing is a better caption
      // than anything this file could invent from a tool name.
      if (event.text.trim()) publishProse(event.text, active.step, active.total)
      return
    case 'tool':
      // The start is recorded separately from the result so a call that never
      // finished — cancelled mid-flight, or the process killed — still appears
      // in the timeline as a call that began.
      trace('agent.tool', { step: event.step, tool: event.name })
      {
        const label = describeCall({
          id: '',
          tool: event.name,
          arguments: event.args,
          fingerprint: '',
          narration: event.narration
        })
        active.callLabels.push({ step: event.step, name: event.name, label })
        publish({
          phase: 'acting',
          step: event.step,
          total: active.total,
          label,
          actions: actionRows()
        })
      }
      return
    case 'present':
      // A picture, not a phase: the card's caption and the run's verdict do
      // not change. The host draws it and returns immediately, so the action
      // that follows is not waiting for an animation.
      present(event.presentation)
      return
    case 'stepTiming':
      // The round trip, as the agent measured it. `promptBytes` and `history`
      // are here because they explain the duration better than the duration
      // does: a slow step on a small history is the network, the same step on
      // a large one is the prompt.
      trace('agent.llm', {
        step: event.step,
        llmMs: ms(event.timing.llmMs),
        promptBytes: event.timing.promptBytes,
        history: event.timing.history,
        calls: event.timing.calls,
        ...(event.timing.inputTokens === undefined ? {} : { inputTokens: event.timing.inputTokens }),
        ...(event.timing.outputTokens === undefined ? {} : { outputTokens: event.timing.outputTokens })
      })
      return
    case 'result': {
      const pendingLabel = active.callLabels.findIndex(
        (entry) => entry.step === event.step && entry.name === event.name
      )
      const label = pendingLabel >= 0 ? active.callLabels.splice(pendingLabel, 1)[0].label : lastLabel() || event.name
      active.actions.push({
        tool: event.name,
        label,
        ok: event.ok
      })
      // The phases are recorded separately because they have different fixes;
      // a field that did not run is omitted rather than written as 0.
      trace('agent.call', {
        step: event.step,
        tool: event.name,
        ok: event.ok,
        ...roundedTiming(event.timing)
      })
      publish({ phase: 'acting', step: event.step, total: active.total, actions: actionRows() })
      return
    }
    case 'runReport':
      trace('agent.report', {
        steps: event.report.steps,
        calls: event.report.calls,
        failedCalls: event.report.failedCalls,
        totalMs: ms(event.report.totalMs),
        llmMs: ms(event.report.llmMs),
        toolMs: ms(event.report.toolMs),
        // The split that decides what to fix: waiting on the model versus
        // working on the machine. Percentages rather than a second opinion on
        // the raw numbers, because the ratio is the point.
        modelShare: share(event.report.llmMs, event.report.totalMs)
      })
      if (event.report.table) trace('agent.timings', { table: event.report.table })
      return
    case 'approval':
      ask(event.request)
      return
    case 'warning':
      // The loop guard fired and the run goes on. Recorded because a run that
      // needed the warning is a run that nearly failed, but it must not touch
      // `stopped`: that field is the verdict, and a warning is not one.
      //
      // Kept on the run as well as traced, so the host can tell the user what
      // the run had to work around — a refused screenshot is the case that
      // exists today, and without this the answer simply arrives with no
      // drawing and no explanation.
      active.notice = event.reason
      trace('agent.warned', { reason: event.reason, step: active.step })
      return
    case 'stopped':
      // Recorded, not published. The agent says why it gave up and then ends
      // the run anyway, so a `done` always follows — and a stop drawn as its
      // own terminal state would be overwritten a tick later. The reason is
      // kept for the `done` that is about to arrive.
      active.stopped = event.reason
      trace('agent.stopped', { reason: event.reason, step: active.step })
      return
    case 'done': {
      // A run that gave up is not a run that finished. The verdict comes from
      // the agent, which knows which exit it took; `active.stopped` is the
      // fallback for the reason, because the stop event carries a more
      // specific one than "it did not finish".
      //
      // The loop's closing sentence on this path is its own diagnostic
      // ("Stopped after 3 steps without finishing the task"), not the model's,
      // so it is not the answer — the card says what happened in the user's
      // language instead.
      const stopped = event.complete ? null : (active.stopped ?? UNKNOWN_STOP)
      if (stopped !== null) {
        const explanation = stopMessage(stopped, active.total)
        publish({
          phase: 'done',
          completed: false,
          step: active.step,
          total: active.total,
          label: explanation,
          actions: actionRows(),
          approval: null,
          message: explanation
        })
        settleRun({ answer: '', actions: actionRows(), message: explanation, incomplete: true })
        return
      }
      publish({
        phase: 'done',
        completed: true,
        step: active.step,
        total: active.total,
        label: 'Готово',
        actions: actionRows(),
        approval: null
      })
      settleRun({ answer: event.answer, actions: actionRows() })
      return
    }
    case 'cancelled':
      publish({
        phase: 'aborted',
        step: active.step,
        total: active.total,
        label: '',
        actions: actionRows(),
        approval: null,
        message: 'Остановлено.'
      })
      settleRun({ answer: '', actions: actionRows(), aborted: true, message: 'Остановлено.' })
      return
    case 'error':
      publish({
        phase: 'error',
        step: active.step,
        total: active.total,
        label: '',
        actions: actionRows(),
        approval: null,
        message: event.message
      })
      settleRun({ answer: '', actions: actionRows(), message: event.message })
      return
  }
}
