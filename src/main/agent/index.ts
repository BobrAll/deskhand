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

import { systemPreferences } from 'electron'
import type {
  AgentActionRow,
  AgentAvailability,
  AgentEvent,
  AgentRunResult,
  AgentToolRequest
} from '@shared/types'
import { helperBinary, watchForAbort, type AbortWatcher } from '../native/helper'
import { getSettings, patchSettings } from '../settings/store'
import { classifyCall, describeCall, rememberKey } from './approval'
import { agentBinary, AgentSidecar, type AgentProvider, type AgentSidecarEvent } from './sidecar'
import { trace } from './trace'

export interface AgentHost {
  /** Makes the card ignore the mouse while the agent works, and take it back while it asks. */
  setPassthrough(active: boolean): void
  /** Reports progress to the card. */
  emit(event: AgentEvent): void
}

/** What one run needs to know: the request, where it started, and the model. */
export interface AgentRunInput {
  /** What the user asked for, in their words. */
  prompt: string
  /** The app the card was opened in, as a hint about where to look first. */
  appName: string | null
  windowTitle: string | null
  /** The model the user configured, with the key only the main process holds. */
  provider: AgentProvider
}

const EMPTY: AgentEvent = { phase: 'idle', step: 0, total: 0, label: '' }

/**
 * A question nobody answers must not hang the run.
 *
 * Long enough that a user who walked away can come back and answer it, short
 * enough that a forgotten card does not leave a click-through window on screen
 * for the rest of the day. The agent has its own ceiling; this one is the host's.
 */
const APPROVAL_TIMEOUT_MS = 5 * 60_000

export function createAgentController(host: AgentHost) {
  const sidecar = new AgentSidecar()
  let watcher: AbortWatcher | null = null
  /** Bumped by `stop()`; a run compares it and gives up. */
  let generation = 0
  let running = false
  let last: AgentEvent = EMPTY

  /** The run in flight, if any. */
  let current: {
    actions: AgentActionRow[]
    step: number
    total: number
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
        reason: 'Компонент агента не собран — выполните `npm run build:agent`.'
      }
    }
    if (!helperBinary()) {
      return {
        enabled: true,
        ready: false,
        reason: 'Нативный helper не собран — следить за Escape нечем.'
      }
    }
    let trusted = false
    try {
      trusted = systemPreferences.isTrustedAccessibilityClient(false)
    } catch {
      trusted = false
    }
    if (!trusted) {
      return {
        enabled: true,
        ready: false,
        reason: 'Нужен доступ «Универсальный доступ», иначе macOS не даст нажимать за вас.'
      }
    }
    return { enabled: true, ready: true, reason: null }
  }

  /** Merges a patch into the last event and publishes it. */
  function publish(patch: Partial<AgentEvent> & { phase: AgentEvent['phase'] }): void {
    last = {
      phase: patch.phase,
      step: patch.step ?? last.step,
      total: patch.total ?? last.total,
      label: patch.label ?? last.label,
      completed: patch.completed ?? (patch.phase === 'done' ? true : undefined),
      approval: patch.approval !== undefined ? patch.approval : (last.approval ?? null),
      actions: patch.actions ?? last.actions,
      message: patch.message
    }
    host.emit(last)
  }

  /** The rows the card lists: what was done, oldest first. */
  function rows(): AgentActionRow[] {
    return current ? [...current.actions] : []
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
  async function run(input: AgentRunInput): Promise<AgentRunResult> {
    if (running) return { answer: '', actions: [], message: 'Агент уже выполняет действие.' }
    const settings = getSettings()
    const state = availability()
    if (!state.ready) {
      const message = state.reason ?? 'Агентный режим недоступен.'
      publish({ phase: 'error', step: 0, total: 0, label: '', message })
      return { answer: '', actions: [], message, blocked: true }
    }

    const token = ++generation
    running = true
    const actions: AgentActionRow[] = []
    const total = settings.agent.maxSteps
    let settled = false
    const done = new Promise<AgentRunResult>((resolve) => {
      current = {
        actions,
        step: 0,
        total,
        pending: null,
        finish: (result) => {
          if (settled) return
          settled = true
          resolve(result)
        }
      }
    })

    publish({ phase: 'arming', step: 0, total, label: 'Приготовился', actions: [], approval: null })
    // The card must not eat the agent's clicks from here on. It is lifted again
    // for each question and put back after the answer.
    host.setPassthrough(true)

    // The mouse is the most reliable "no" there is: reaching for the pointer takes
    // control back before the next click lands. Escape works always.
    watcher = watchForAbort({ watchMouse: settings.agent.abortOnMouseMove }, (reason) => {
      if (token !== generation) return
      trace('agent.abort', { reason })
      stop(reason === 'mousemove' ? 'Остановлено: вы взяли мышь.' : 'Остановлено по Escape.')
    })

    const off = sidecar.onEvent((event) => {
      if (token !== generation) return
      handle(event)
    })

    try {
      await sidecar.run({
        task: taskText(input),
        provider: input.provider,
        maxSteps: total,
        verifyActions: settings.agent.verifyResult
      })
      trace('agent.run', { maxSteps: total, hasApp: Boolean(input.appName) })
    } catch (error) {
      finish({
        answer: '',
        actions: rows(),
        message: error instanceof Error ? error.message : 'Не удалось запустить агента.',
        blocked: true
      })
    }

    const result = await done
    off()
    watcher?.stop()
    watcher = null
    running = false
    current = null
    // Whatever ended the run, the card takes the mouse back: leaving it
    // click-through would leave a panel nobody can press a button on.
    host.setPassthrough(false)
    return result
  }

  /** One event from the agent, as the card sees it. */
  function handle(event: AgentSidecarEvent): void {
    const active = current
    if (!active) return
    switch (event.kind) {
      case 'ready':
        return
      case 'step':
        active.step = event.step
        active.total = event.total || active.total
        publish({
          phase: 'acting',
          step: event.step,
          total: active.total,
          label: last.label || 'Работаю',
          actions: rows()
        })
        return
      case 'narration':
        // The model's own sentence about what it is doing is a better caption
        // than anything this file could invent from a tool name.
        if (event.text.trim()) {
          publish({
            phase: last.phase === 'asking' ? 'acting' : last.phase,
            step: active.step,
            total: active.total,
            label: event.text.trim(),
              actions: rows()
          })
        }
        return
      case 'tool':
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
          actions: rows()
        })
        return
      case 'result':
        active.actions.push({
          tool: event.name,
          label: last.label || event.name,
          ok: event.ok
        })
        trace('agent.call', { tool: event.name, ok: event.ok })
        publish({ phase: 'acting', step: event.step, total: active.total, actions: rows() })
        return
      case 'approval':
        ask(event.request)
        return
      case 'stopped':
        publish({
          phase: 'error',
          step: active.step,
          total: active.total,
          label: '',
          actions: rows(),
          message: event.reason
        })
        return
      case 'done':
        publish({
          phase: 'done',
          completed: true,
          step: 0,
          total: 0,
          label: 'Готово',
          actions: rows(),
          approval: null
        })
        finish({ answer: event.answer, actions: rows() })
        return
      case 'cancelled':
        publish({
          phase: 'aborted',
          step: 0,
          total: 0,
          label: '',
          actions: rows(),
          approval: null,
          message: 'Остановлено.'
        })
        finish({ answer: '', actions: rows(), aborted: true, message: 'Остановлено.' })
        return
      case 'error':
        publish({
          phase: 'error',
          step: active.step,
          total: active.total,
          label: '',
          actions: rows(),
          approval: null,
          message: event.message
        })
        finish({ answer: '', actions: rows(), message: event.message })
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
      sidecar.approve(request.id, true)
      return
    }
    if (decision.kind === 'deny') {
      trace('agent.approval', { outcome: 'denied' })
      sidecar.approve(request.id, false, decision.reason)
      active.actions.push({ tool: request.tool, label: decision.reason, ok: false })
      publish({ phase: 'acting', actions: rows() })
      return
    }

    trace('agent.approval', { outcome: 'asked', tool: request.tool })
    host.setPassthrough(false)
    const settle = (allow: boolean, remember: boolean, reason?: string): void => {
      const pending = active.pending
      if (!pending || pending.request.id !== request.id) return
      clearTimeout(pending.timer)
      active.pending = null
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
      sidecar.approve(
        request.id,
        allow,
        allow ? undefined : (reason ?? 'Пользователь отклонил действие.')
      )
      if (allow) {
        // The panel had the mouse and the focus for a moment; the agent's next
        // click must not land on it.
        host.setPassthrough(true)
        publish({ phase: 'acting', approval: null, actions: rows() })
      } else {
        publish({
          phase: 'aborted',
          label: '',
          approval: null,
          actions: rows(),
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
      actions: rows(),
      approval: request,
      message: decision.detail
    })
  }

  /** Ends the run: the answer has arrived, or something went wrong. */
  function finish(result: AgentRunResult): void {
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
    if (running) trace('agent.stop')
    generation += 1
    const active = current
    if (active?.pending) {
      const pending = active.pending
      clearTimeout(pending.timer)
      active.pending = null
      sidecar.approve(pending.request.id, false, 'Отменено.')
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
    finish({ answer: '', actions: rows(), aborted: true, message })
  }

  /** Releases the process; called on quit so no agent outlives the window. */
  function dispose(): void {
    watcher?.stop()
    watcher = null
    sidecar.dispose()
  }

  return {
    availability,
    run,
    stop,
    answer,
    dispose,
    last: () => last
  }
}

/**
 * The task, as the agent reads it.
 *
 * The prompt is the request; the app and the window are where to look first. They
 * are stated as context and not as instructions on purpose — the agent decides
 * which app to touch by calling `get_app_state`, and telling it "the answer is in
 * this window" would be the host making a decision the screen is better placed to
 * make.
 */
function taskText(input: AgentRunInput): string {
  const lines: string[] = []
  if (input.appName) lines.push(`Приложение: ${input.appName}`)
  if (input.windowTitle) lines.push(`Окно: ${input.windowTitle}`)
  if (lines.length > 0) lines.push('')
  lines.push(input.prompt.trim())
  return lines.join('\n')
}
