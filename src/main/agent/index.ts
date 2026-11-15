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

import type { AgentActionRow, AgentAvailability, AgentEvent, AgentPresentation, AgentRunResult } from '@shared/types'
import { helperBinary, watchForAbort, type AbortWatcher } from '../native/helper'
import { accessibilityTrusted } from '../permissions'
import { getSettings } from '../settings/store'
import { createApprovalPrompt } from './approvalPrompt'
import { agentBinary, AgentSidecar } from './sidecar'
import { trace, traceWithin } from './trace'
import { taskText, withAgentBudget, type AgentRunInput } from './runRequest'
import { createRunTrace } from './run-trace'
import { handleRunEvent, type RunEventState } from './runEvents'

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
  /**
   * Whether the card owns the keyboard for the approval question.
   *
   * When it does, Escape is handled by the renderer's keydown; when it does not,
   * the native watcher has to answer the question itself.
   */
  hasFocus?(): boolean
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

export type { AgentExchange, AgentRunInput } from './runRequest'

const IDLE_EVENT: AgentEvent = { phase: 'idle', step: 0, total: 0, label: '' }

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
  /** The last event the card was told about. */
  let lastPublished: AgentEvent = IDLE_EVENT

  /** The run in flight, if any. */
  let current:
    | (RunEventState & {
        finish(result: AgentRunResult): void
      })
    | null = null

  const approvals = createApprovalPrompt({
    currentRun: () => current,
    approve,
    publish,
    actionRows,
    lastLabel: () => lastPublished.label,
    setPassthrough: (active) => host.setPassthrough(active),
    focus: () => host.focus?.(),
    hasFocus: () => host.hasFocus?.()
  })

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
   * The model's own words in the status row.
   *
   * The streamed prefix and the finished narration are the same sentence about
   * the same step, so they are cut and drawn the same way; a paragraph in the
   * status row would widen the card. A question on screen turns back into
   * `acting` here, because the agent's prose means it has moved on.
   */
  function publishProse(text: string, step: number, total: number): void {
    publish({
      phase: lastPublished.phase === 'asking' ? 'acting' : lastPublished.phase,
      step,
      total,
      label: caption(text),
      actions: actionRows()
    })
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
        callLabels: [],
        stopped: null,
        notice: null,
        firstToken: false,
        finish: (result) => {
          if (settled) return
          settled = true
          resolve(result)
        }
      }
    })
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
      // A blocked run has no actions of its own. Without this, a previous run's
      // history survives in `lastPublished` and appears under the new error.
      publish({ phase: 'error', step: 0, total: 0, label: '', actions: [], message, code: 'blocked' })
      return { answer: '', actions: [], message, blocked: true }
    }

    const token = ++generation
    running = true
    activeTrace = runTrace
    approvals.resetGrace()
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
        const message = error instanceof Error ? error.message : 'Не удалось запустить агента.'
        // A start that failed has no further event to come: leaving the card on
        // `arming` would show «Подготовка» for a run that is already over.
        publish({ phase: 'error', step: 0, total: 0, label: '', message, code: 'blocked' })
        settleRun({
          answer: '',
          actions: actionRows(),
          message,
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
      if (approvals.consumeAbort(reason)) return
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
      if (current) {
        handleRunEvent(current, event, {
          publish,
          publishProse,
          actionRows,
          present: (action) => host.present?.(action),
          ask: approvals.ask,
          settleRun,
          lastLabel: () => lastPublished.label
        })
      }
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

  /** Ends the run: the answer has arrived, or something went wrong. */
  function settleRun(result: AgentRunResult): void {
    const active = current
    if (!active) return
    approvals.clearPending()
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
    approvals.cancel()
    sidecar.cancel()
    watcher?.stop()
    watcher = null
    if (!running) return
    publish({
      phase: 'aborted',
      step: current?.step ?? 0,
      total: current?.total ?? 0,
      label: '',
      actions: actionRows(),
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
    answer: approvals.answer,
    dispose,
    last: () => lastPublished
  }
}
