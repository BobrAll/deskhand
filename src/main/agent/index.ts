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
import { agentBinary, AgentSidecar, type AgentProvider } from './sidecar'
import { trace, traceWithin } from './trace'
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
  /** The same for the Escape that the renderer may have handled already. */
  let ignoreEscapeUntil = 0
  /** The last event the card was told about. */
  let lastPublished: AgentEvent = IDLE_EVENT

  /** The run in flight, if any. */
  let current:
    | (RunEventState & {
        /** The question waiting for the user; null when nothing is being asked. */
        pending: {
          request: AgentToolRequest
          timer: ReturnType<typeof setTimeout>
          settle(allow: boolean, remember: boolean, refusal?: Refusal): void
        } | null
        finish(result: AgentRunResult): void
      })
    | null = null

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
   * Called from the card through IPC. Idempotent on purpose: a second click on
   * a button that was already handled, or an Escape arriving in the same tick
   * as an answer, must not decide twice.
   */
  function answer(id: string, allow: boolean, remember: boolean): void {
    const pending = current?.pending
    if (!pending || pending.request.id !== id) return
    pending.settle(allow, remember)
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
    ignoreMouseUntil = 0
    ignoreEscapeUntil = 0
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
      // Reaching for the answer is not taking control back. A question makes the
      // card clickable, and the hand on the mouse is on its way to «Разрешить»;
      // stopping the run there was the bug.
      if (reason === 'mousemove' && (current?.pending || Date.now() < ignoreMouseUntil)) return
      // An open question owns Escape. The focused card answers it itself; only
      // when the user clicked away does the native watcher answer, so Escape
      // cannot be swallowed by the app behind the question.
      if (reason === 'escape' && current?.pending) {
        if (host.hasFocus?.() !== false) return
        current.pending.settle(false, false, REFUSED)
        return
      }
      // The renderer may have answered the question a moment ago; its keydown
      // reaches us in the same keystroke.
      if (reason === 'escape' && Date.now() < ignoreEscapeUntil) return
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
          ask,
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
      // The model reads `reason` as a tool result, so it is English; the row the
      // card lists keeps the user's language.
      approve(request.id, false, decision.reason)
      active.actions.push({ tool: request.tool, label: decision.label, ok: false })
      publish({ phase: 'acting', actions: actionRows(), code: 'secret' })
      return
    }

    trace('agent.approval', { outcome: 'asked', tool: request.tool })
    host.setPassthrough(false)
    // The card is clickable now; the keyboard should reach the answer too.
    host.focus?.()
    const settle = (allow: boolean, remember: boolean, refusal: Refusal = REFUSED): void => {
      const pending = active.pending
      if (!pending || pending.request.id !== request.id) return
      clearTimeout(pending.timer)
      active.pending = null
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
      host.setPassthrough(true)
      // A refusal is not `aborted`: nothing stopped. The run goes on, so a
      // terminal phase here would say "stopped" over work that is still
      // happening — and leave the card in front of the window the agent was
      // about to press.
      publish({
        phase: 'acting',
        approval: null,
        label: allow ? lastPublished.label : refusal.label,
        actions: actionRows()
      })
    }
    const timer = setTimeout(() => {
      trace('agent.approval', { outcome: 'timeout', tool: request.tool })
      settle(false, false, NOT_CONFIRMED)
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
    ignoreEscapeUntil = 0
    const active = current
    if (active?.pending) {
      const pending = active.pending
      clearTimeout(pending.timer)
      active.pending = null
      approve(pending.request.id, false, CANCELLED_REASON)
    }
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
