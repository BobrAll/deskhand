/**
 * The agent controller: one run, one card, one stop button.
 *
 * The agent itself is the Swift process in `native/deskhand` (see `sidecar.ts`).
 * What lives here is everything that is about the *user* rather than about the
 * machine:
 *
 * **1. Whether it may run at all.** The mode is off by default, needs the
 * Accessibility grant and needs the sidecar to exist. Three separate reasons,
 * because they have three different fixes — the card prints the reason instead of
 * offering a button that would quietly do nothing.
 *
 * **2. Whether it may do *this*.** The agent asks before every mutating call and
 * blocks until answered. The answer is a button in the card, not a modal sheet:
 * the question is about the element the agent named, and a dialog that covers its
 * own evidence is worse than no dialog. `approval.ts` decides which calls are
 * asked about at all.
 *
 * **3. How to stop it.** Escape, a hand on the mouse, closing the card and
 * quitting the app all reach `stop()`. An agent that cannot be interrupted is not
 * a feature.
 *
 * Everything else — coordinates, element indices, batching, verifying its own
 * clicks, trimming its own history — belongs to the agent and is deliberately not
 * re-implemented here.
 */

import type {
  AgentActionRow,
  AgentAvailability,
  AgentEvent,
  AgentPresentation,
  AgentRunResult,
  AgentToolRequest
} from '@shared/types'
import { helperBinary, watchForAbort, type AbortWatcher } from '../native/helper'
import { accessibilityTrusted } from '../permissions'
import { getSettings, patchSettings } from '../settings/store'
import { AGENT_MIN_OUTPUT_TOKENS } from '@shared/defaults'
import { classifyCall, describeCall, rememberKey } from './approval'
import {
  agentBinary,
  AgentSidecar,
  type AgentProvider,
  type AgentSidecarEvent,
  type AgentToolTiming
} from './sidecar'
import { trace, traceWithin } from './trace'
import { createRunTrace } from './run-trace'

export interface AgentHost {
  /** Makes the card ignore the mouse while the agent works, and take it back while it asks. */
  setPassthrough(active: boolean): void
  /**
   * Takes the keyboard for an approval question.
   *
   * Optional so a headless host can ignore it. The run is blocked on the answer,
   * so focusing the card cannot interrupt an action.
   */
  focus?(): void
  /** Reports progress to the card. */
  emit(event: AgentEvent): void
  /**
   * Draws one action before it runs.
   *
   * Optional so a headless host (and a test) can ignore the picture. The call
   * must not block: the action is waiting on the same thread.
   */
  present?(action: AgentPresentation): void
}

/** One earlier question and the answer it got, as the agent reads it. */
export interface AgentExchange {
  question: string
  answer: string
}

/** What one run needs to know: the request, where it started, and the model. */
export interface AgentRunInput {
  /** What the user asked for, in their words. */
  prompt: string
  /** The app the card was opened in, as a hint about where to look first. */
  appName: string | null
  windowTitle: string | null
  /**
   * What was said before this request, oldest first.
   *
   * «Сделай» is a complete request only in the sentence it answers. The writer
   * already gets these turns, so a follow-up there means something; without
   * them here the same follow-up reaches the agent as a verb with no object,
   * and the only honest answer it can give is to ask what to do. Passing them
   * is what makes the agent part of the same conversation rather than a fresh
   * one that happens to start mid-sentence.
   */
  history?: AgentExchange[]
  /** The model the user configured, with the key only the main process holds. */
  provider: AgentProvider
  /** Bundle ids the agent must never read or act on. */
  excludedApps?: string[]
}

const IDLE_EVENT: AgentEvent = { phase: 'idle', step: 0, total: 0, label: '' }

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

/**
 * One line of streamed prose, cut to what the card can draw.
 *
 * The model's narration is a caption of a few words. The final answer is not —
 * it can be a paragraph, and it arrives in the answer area at the end anyway.
 * Letting a paragraph grow in the status row would resize the window on every
 * token and show the same text twice.
 */
function caption(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > 120 ? `${line.slice(0, 117)}…` : line
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
    return `Не успел за ${total} ${plural(total, 'шаг', 'шага', 'шагов')} — задача осталась ` +
      'невыполненной. Увеличь лимит шагов в настройках или уточни запрос.'
  }
  if (reason.includes(STOP_TOKEN_LIMIT)) {
    // Not the same problem as running out of steps: the run had budget left, but
    // every answer was cut in half, so the model never got to say what it wanted
    // to do. Raising the step limit would not help — the fix is the output
    // length.
    return 'Остановился: ответ модели обрывался по лимиту длины. Увеличь максимум ' +
      'токенов в настройках — задача осталась невыполненной.'
  }
  if (reason.includes(STOP_RETURNING_TO_SCREEN)) {
    // Not the same as a repeated call: the run tried different things and kept
    // arriving at the same screen. Raising the step limit would only buy more of
    // the same, so the honest answer names the loop instead.
    return 'Остановился: несколько шагов подряд экран не менялся — задача пошла по кругу. ' +
      'Задача осталась невыполненной.'
  }
  return 'Задача осталась невыполненной.'
}

/**
 * The provider settings, with enough output room for an agent step.
 *
 * `maxTokens` is the writer's number: it was picked for prose, where 1024 is a
 * generous answer. An agent step is a different shape — a sentence of reasoning
 * wrapped around a tool call whose arguments are nested JSON — and at 1024 the
 * reply gets cut off mid-call. The half-written call parses into no calls at all,
 * so the step arrives as an empty message and the run is thrown away.
 *
 * The floor is applied here rather than by changing the setting, so the writer
 * keeps its own budget and an existing 1024 in the user's settings cannot
 * resurrect the failure.
 */
function withAgentBudget(provider: AgentProvider): AgentProvider {
  if (provider.maxTokens >= AGENT_MIN_OUTPUT_TOKENS) return provider
  return { ...provider, maxTokens: AGENT_MIN_OUTPUT_TOKENS }
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

export function createAgentController(host: AgentHost) {
  const sidecar = new AgentSidecar()
  const runs = new Set<Promise<AgentRunResult>>()
  let activeTrace: ReturnType<typeof createRunTrace> | null = null

  function approve(id: string, allow: boolean, reason?: string): void {
    activeTrace?.record('approval-decision', { id, allow, reason })
    sidecar.approve(id, allow, reason)
  }
  let watcher: AbortWatcher | null = null
  /** Bumped by `stop()`; a run compares it and gives up. */
  let generation = 0
  let running = false
  /** Mouse movements before this instant belong to the answer, not to a stop. */
  let ignoreMouseUntil = 0
  /** The last event the card was told about. */
  let lastPublished: AgentEvent = IDLE_EVENT

  /** The run in flight, if any. */
  let current: {
    actions: AgentActionRow[]
    step: number
    total: number
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
    /** The question waiting for the user; null when nothing is being asked. */
    pending: {
      request: AgentToolRequest
      timer: ReturnType<typeof setTimeout>
      settle(allow: boolean, remember: boolean, reason?: string): void
    } | null
    finish(result: AgentRunResult): void
  } | null = null

  /**
   * Whether the mode can be used at all right now.
   *
   * Synchronous on purpose: the answer is needed while the overlay state is being
   * built, and spawning a process just to ask a question Electron can answer from
   * its own cache would add a round trip to every hotkey press.
   */
  function availability(): AgentAvailability {
    const settings = getSettings()
    if (!settings.agent.enabled) {
      return { enabled: false, ready: false, reason: 'Агентный режим выключен в настройках.' }
    }
    if (!agentBinary()) {
      return {
        enabled: true,
        ready: false,
        reason: 'Компонент агента не собран — выполни `npm run build:agent`.'
      }
    }
    if (!helperBinary()) {
      return {
        enabled: true,
        ready: false,
        reason: 'Нативный helper не собран — следить за Escape нечем.'
      }
    }
    if (!accessibilityTrusted()) {
      return {
        enabled: true,
        ready: false,
        needsAccessibility: true,
        reason: 'Нужен доступ «Универсальный доступ», иначе macOS не даст нажимать за тебя.'
      }
    }
    return { enabled: true, ready: true, reason: null }
  }

  /** Merges a patch into the last event and publishes it. */
  function publish(patch: Partial<AgentEvent> & { phase: AgentEvent['phase'] }): void {
    lastPublished = {
      phase: patch.phase,
      step: patch.step ?? lastPublished.step,
      total: patch.total ?? lastPublished.total,
      label: patch.label ?? lastPublished.label,
      completed: patch.completed ?? (patch.phase === 'done' ? true : undefined),
      approval: patch.approval !== undefined ? patch.approval : (lastPublished.approval ?? null),
      actions: patch.actions ?? lastPublished.actions,
      message: patch.message,
      code: patch.code,
      // Carried on every event rather than only the last one, so a host that
      // redraws mid-run sees it too — and so the overlay can read it off the run
      // without a second channel that would have to be kept in step.
      notice: patch.notice ?? current?.notice ?? undefined
    }
    host.emit(lastPublished)
  }

  /** The rows the card lists: what was done, oldest first. */
  function actionRows(): AgentActionRow[] {
    return current ? [...current.actions] : []
  }

  /**
   * Opens the run's state and returns the promise its verdict settles.
   *
   * The assignment happens synchronously inside the executor, so the `publish`
   * that follows already sees the run it is describing.
   */
  function beginRun(actions: AgentActionRow[], total: number): Promise<AgentRunResult> {
    let settled = false
    return new Promise<AgentRunResult>((resolve) => {
      current = {
        actions,
        step: 0,
        total,
        stopped: null,
        notice: null,
        firstToken: false,
        pending: null,
        finish: (result) => {
          if (settled) return
          settled = true
          resolve(result)
        }
      }
    })
  }

  /**
   * Answers the pending question.
   *
   * Called from the card through IPC, and from `stop()` with a refusal. Idempotent
   * on purpose: a second click on a button that was already handled, or an Escape
   * arriving in the same tick as an answer, must not decide twice.
   */
  function answer(id: string, allow: boolean, remember: boolean, reason?: string): void {
    const pending = current?.pending
    if (!pending || pending.request.id !== id) return
    pending.settle(allow, remember, reason)
  }

  /**
   * Runs one task.
   *
   * Resolves when the run is over, whatever ended it. The card hears about every
   * phase through `host.emit`, so the caller only has to deal with the outcome —
   * and to put it into the answer.
   */
  function run(input: AgentRunInput): Promise<AgentRunResult> {
    // A turn of its own when the caller did not open one. The recorder is
    // silent outside a turn by design, so a run that reached here from a path
    // that does not trace would otherwise be invisible — and an invisible run
    // is indistinguishable from one that never happened.
    const request = traceWithin({ source: 'agent-controller' }, async () => {
      const runTrace = createRunTrace({ detailed: getSettings().agent.saveRunTraces })
      runTrace.record('start', {
        prompt: input.prompt,
        appName: input.appName,
        windowTitle: input.windowTitle,
        // How many earlier turns came with the request, not what they said: a
        // follow-up that arrived alone is the difference between a run that
        // could work and one that can only ask what to do.
        historyTurns: input.history?.length ?? 0,
        model: input.provider.model,
        wire: input.provider.wire
      })
      try {
        const result = await runTurn(input, runTrace)
        runTrace.record('end', result)
        return result
      } catch (error) {
        runTrace.record('end', { error: error instanceof Error ? error.message : String(error) })
        throw error
      } finally {
        await runTrace.close()
      }
    })
    runs.add(request)
    const forget = () => runs.delete(request)
    void request.then(forget, forget)
    return request
  }

  async function runTurn(input: AgentRunInput, runTrace: ReturnType<typeof createRunTrace>): Promise<AgentRunResult> {
    if (running) return { answer: '', actions: [], message: 'Агент уже выполняет действие.' }
    const settings = getSettings()
    const state = availability()
    if (!state.ready) {
      const message = state.reason ?? 'Агентный режим недоступен.'
      publish({ phase: 'error', step: 0, total: 0, label: '', message, code: 'blocked' })
      return { answer: '', actions: [], message, blocked: true }
    }

    const token = ++generation
    running = true
    activeTrace = runTrace
    ignoreMouseUntil = 0
    const actions: AgentActionRow[] = []
    const total = settings.agent.maxSteps
    const provider = withAgentBudget(input.provider)
    const done = beginRun(actions, total)

    publish({ phase: 'arming', step: 0, total, label: 'Приготовился', actions: [], approval: null })
    trace('agent.start', {
      maxSteps: total,
      verify: settings.agent.verifyResult,
      hasApp: Boolean(input.appName),
      // The ceiling on one step's answer. Without it a run that died because a
      // reply was cut in half leaves nothing in the trace but an empty step.
      maxTokens: provider.maxTokens
    })
    // The card must not eat the agent's clicks from here on. It is lifted again
    // for each question and put back after the answer.
    host.setPassthrough(true)

    const stopListening = subscribeToRun(token, runTrace, {
      abortOnMouseMove: settings.agent.abortOnMouseMove
    })

    try {
      const task = taskText(input)
      runTrace.record('dispatch', { task, maxSteps: total, verifyActions: settings.agent.verifyResult })
      await sidecar.run({
        task,
        traceRunId: runTrace.id,
        provider,
        maxSteps: total,
        verifyActions: settings.agent.verifyResult,
        // Presentation only: the same run either way. `showActions` is the
        // switch a background mode will turn off, and the agent treats it as
        // "describe what you are about to do", not as "do it differently".
        visualize: settings.agent.showActions !== false,
        excludedApps: input.excludedApps ?? []
      })
      // A stop can land while the sidecar is starting, before this run reaches
      // the pipe. `done` is already settled with the stop; recording an
      // acceptance would put a start in the trace for an agent that never ran.
      if (token === generation) trace('agent.accepted', { maxSteps: total })
    } catch (error) {
      // The same for a start that failed after the stop: the card already says
      // what happened, and a second verdict would replace the user's message.
      if (token === generation) {
        settleRun({
          answer: '',
          actions: actionRows(),
          message: error instanceof Error ? error.message : 'Не удалось запустить агента.',
          blocked: true
        })
      }
    }

    const result = await done
    stopListening()
    releaseRun()
    return result
  }

  /**
   * Starts listening for the run: the user's way out, and the agent's events.
   *
   * Returns the function that stops both. The run is identified by `token`, so a
   * callback that outlives it — a mouse move after the next run started — is
   * ignored rather than applied to the wrong run.
   */
  function subscribeToRun(
    token: number,
    runTrace: ReturnType<typeof createRunTrace>,
    options: { abortOnMouseMove: boolean }
  ): () => void {
    // The mouse is the most reliable "no" there is: reaching for the pointer takes
    // control back before the next click lands. Escape works always.
    watcher = watchForAbort(options.abortOnMouseMove ? 'mouse' : 'key', (reason) => {
      if (token !== generation) return
      // Reaching for the answer is not taking control back. A question makes the
      // card clickable, and the hand on the mouse is on its way to «Разрешить»;
      // stopping the run there was the bug. Escape still refuses it.
      if (reason === 'mousemove' &&
          (current?.pending || Date.now() < ignoreMouseUntil)) return
      trace('agent.abort', { reason })
      stop(reason === 'mousemove' ? 'Остановлено: ты взял мышь.' : 'Остановлено по Escape.')
    })

    const off = sidecar.onEvent((event) => {
      if (token !== generation) return
      if (event.kind === 'modelTrace') {
        runTrace.record(event.event, { step: current?.step, ...event.data })
        return
      }
      // The wire response carries the stream. Avoid writing every growing
      // prefix a second time as the UI receives it.
      if (event.kind !== 'stream') runTrace.record(event.kind, event)
      handleSidecarEvent(event)
    })

    return () => {
      off()
      watcher?.stop()
      watcher = null
    }
  }

  /** Forgets the finished run and gives the card its mouse back. */
  function releaseRun(): void {
    running = false
    current = null
    activeTrace = null
    // Whatever ended the run, the card takes the mouse back: leaving it
    // click-through would leave a panel nobody can press a button on.
    host.setPassthrough(false)
  }

  /** One event from the agent, as the card sees it. */
  function handleSidecarEvent(event: AgentSidecarEvent): void {
    const active = current
    if (!active) return
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
          label: lastPublished.label || 'Работаю',
          actions: actionRows()
        })
        return
      case 'stream':
        // The same caption as `narration`, but while the model is still writing
        // it. This is what turns the first two seconds of every step from a
        // spinner into the model's own words.
        if (event.text.trim()) {
          if (!active.firstToken) {
            active.firstToken = true
            trace('agent.firstToken', { step: active.step, chars: event.text.length })
          }
          publish({
            phase: lastPublished.phase === 'asking' ? 'acting' : lastPublished.phase,
            step: active.step,
            total: active.total,
            label: caption(event.text),
            actions: actionRows()
          })
        }
        return
      case 'narration':
        // The model's own sentence about what it is doing is a better caption
        // than anything this file could invent from a tool name.
        if (event.text.trim()) {
          publish({
            phase: lastPublished.phase === 'asking' ? 'acting' : lastPublished.phase,
            step: active.step,
            total: active.total,
            label: event.text.trim(),
            actions: actionRows()
          })
        }
        return
      case 'tool':
        // The start is recorded separately from the result so a call that never
        // finished — cancelled mid-flight, or the process killed — still appears
        // in the timeline as a call that began.
        trace('agent.tool', { step: event.step, tool: event.name })
        publish({
          phase: 'acting',
          step: event.step,
          total: active.total,
          label: describeCall({
            id: '',
            tool: event.name,
            arguments: event.args,
            fingerprint: '',
            narration: event.narration
          }),
          actions: actionRows()
        })
        return
      case 'present':
        // A picture, not a phase: the card's caption and the run's verdict do
        // not change. The host draws it and returns immediately, so the action
        // that follows is not waiting for an animation.
        host.present?.(event.presentation)
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
        active.actions.push({
          tool: event.name,
          label: lastPublished.label || event.name,
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
            step: 0,
            total: 0,
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
          step: 0,
          total: 0,
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
          step: 0,
          total: 0,
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

  /**
   * Puts one question in front of the user and blocks the agent until answered.
   *
   * The card is made clickable for exactly as long as the question is open, and
   * the agent is already blocked on the pipe — so nothing can be clicked behind
   * the panel while the user is deciding.
   */
  function ask(request: AgentToolRequest): void {
    const active = current
    if (!active || active.pending) return
    const decision = classifyCall(request, getSettings().agent.rememberedApprovals)
    if (decision.kind === 'allow') {
      approve(request.id, true)
      return
    }
    if (decision.kind === 'deny') {
      trace('agent.approval', { outcome: 'denied' })
      approve(request.id, false, decision.reason)
      active.actions.push({ tool: request.tool, label: decision.reason, ok: false })
      publish({ phase: 'acting', actions: actionRows(), code: 'secret' })
      return
    }

    trace('agent.approval', { outcome: 'asked', tool: request.tool })
    host.setPassthrough(false)
    // The card is clickable now; the keyboard should reach the answer too.
    host.focus?.()
    const settle = (allow: boolean, remember: boolean, reason?: string): void => {
      const pending = active.pending
      if (!pending || pending.request.id !== request.id) return
      clearTimeout(pending.timer)
      active.pending = null
      // Leaving the button moves the mouse; neither answer should turn that into
      // a stop before the run has had a chance to act on the decision.
      ignoreMouseUntil = Date.now() + APPROVAL_MOUSE_GRACE_MS
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
      approve(
        request.id,
        allow,
        allow ? undefined : (reason ?? 'Пользователь отклонил действие.')
      )
      // The panel had the mouse and the focus for a moment; the agent's next
      // click must not land on it, whether the answer was yes or no.
      host.setPassthrough(true)
      if (allow) {
        publish({ phase: 'acting', approval: null, actions: actionRows() })
      } else {
        publish({
          phase: 'aborted',
          label: '',
          approval: null,
          actions: actionRows(),
          message: 'Действие отклонено.'
        })
      }
    }
    const timer = setTimeout(() => {
      trace('agent.approval', { outcome: 'timeout', tool: request.tool })
      settle(false, false, 'Подтверждение не получено.')
    }, APPROVAL_TIMEOUT_MS)
    active.pending = { request, timer, settle }

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

  /** Ends the run: the answer has arrived, or something went wrong. */
  function settleRun(result: AgentRunResult): void {
    const active = current
    if (!active) return
    if (active.pending) {
      clearTimeout(active.pending.timer)
      active.pending = null
    }
    active.finish(result)
  }

  /**
   * Stops the run in flight. Safe to call when nothing is running.
   *
   * A pending question is refused rather than left open: the agent is blocked on
   * it, so a stop that did not answer it would be a stop that never lands.
   */
  function stop(message = 'Остановлено.'): void {
    if (running) {
      trace('agent.stop')
      activeTrace?.record('stop', { message })
    }
    generation += 1
    ignoreMouseUntil = 0
    const active = current
    if (active?.pending) {
      const pending = active.pending
      clearTimeout(pending.timer)
      active.pending = null
      approve(pending.request.id, false, 'Отменено.')
    }
    sidecar.cancel()
    watcher?.stop()
    watcher = null
    if (!running) return
    publish({
      phase: 'aborted',
      step: 0,
      total: 0,
      label: '',
      approval: null,
      message
    })
    settleRun({ answer: '', actions: actionRows(), aborted: true, message })
  }

  /** Releases the process; called on quit so no agent outlives the window. */
  async function dispose(): Promise<void> {
    if (running) stop('Приложение закрывается.')
    sidecar.dispose()
    await Promise.allSettled(runs)
  }

  return {
    availability,
    run,
    stop,
    answer,
    dispose,
    last: () => lastPublished
  }
}

/**
 * How much of one earlier turn the agent needs.
 *
 * The whole point of the block is the noun the current request leaves out, and
 * that noun is almost always in the first sentences. The card already trims its
 * history; this is the second ceiling, because a long answer would otherwise be
 * paid for on every step of the run, not once.
 */
const HISTORY_TURN_CHARS = 900

/**
 * The task, as the agent reads it.
 *
 * The prompt is the request; the app and the window are where to look first. They
 * are stated as context and not as instructions on purpose — the agent decides
 * which app to touch by calling `get_app_state`, and telling it "the answer is in
 * this window" would be the host making a decision the screen is better placed to
 * make.
 *
 * Earlier turns are quoted only when there are some, and labelled as context: a
 * bare «сделай» has no meaning on its own, but the same word after «можно ли
 * ...? если да — сделай» does. The block is closed with «Текущая задача» so a
 * past request, still full of imperatives, is not read as one to act on now.
 */
function taskText(input: AgentRunInput): string {
  const lines: string[] = []
  if (input.appName) lines.push(`Приложение: ${input.appName}`)
  if (input.windowTitle) lines.push(`Окно: ${input.windowTitle}`)
  if (lines.length > 0) lines.push('')

  const history = input.history?.filter((entry) => entry.question.trim()) ?? []
  if (history.length > 0) {
    lines.push('Разговор до этого — контекст, чтобы понять, к чему относится текущая просьба:')
    for (const entry of history) {
      lines.push(`Пользователь: ${clipHistory(entry.question)}`)
      if (entry.answer.trim()) lines.push(`Ответ: ${clipHistory(entry.answer)}`)
    }
    lines.push('')
    lines.push('Текущая задача:')
  }

  lines.push(input.prompt.trim())
  return lines.join('\n')
}

function clipHistory(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > HISTORY_TURN_CHARS ? `${line.slice(0, HISTORY_TURN_CHARS - 1)}…` : line
}
