/**
 * The bridge to `deskhand-agent --serve`.
 *
 * The agent that actually drives the machine is the Swift package vendored in
 * `native/deskhand`. It runs as a child process because everything it needs —
 * the accessibility tree, ScreenCaptureKit, `CGEvent` — is a system API that
 * wants a Cocoa run loop and a process of its own, and because a wedged capture
 * must not be able to take the window down with it.
 *
 * The protocol is one JSON object per line in both directions: requests carry an
 * `id`, events carry an `event` name. That is deliberately the whole protocol —
 * it is a pipe between two processes that ship together, so a schema and a
 * version negotiation would be ceremony around `JSON.stringify`.
 *
 * What lives here, and what does not:
 *
 * - starting the process, framing lines, matching answers to requests;
 * - deciding *whether the agent may act* — the agent asks before every mutating
 *   call and waits (`approval.ts`, `index.ts`);
 * - nothing about *how* to act. Coordinates, element indices, batching and
 *   verification are the agent's own business, and re-implementing any of them
 *   here is exactly the drift this split exists to prevent.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import type { AgentGesture, AgentPresentation, AgentToolRequest, ScreenRect } from '@shared/types'
import { resourceCandidates } from '../paths'
import { trace } from './trace'

const BINARY_NAME = 'deskhand-agent'

/** How long the agent has to announce itself before the start counts as failed. */
const START_TIMEOUT_MS = 10_000
/** How long one request may wait for its answer. */
const REQUEST_TIMEOUT_MS = 15_000
/** How long a process gets to exit after `shutdown` before it is killed. */
const SHUTDOWN_GRACE_MS = 1_000
/** How much of one stderr line is kept in the trace. */
const MAX_LOG_LINE_CHARS = 300

/** The gesture vocabulary `present` may carry, matching the Swift enum. */
const GESTURES: ReadonlySet<string> = new Set([
  'click',
  'secondary',
  'type',
  'value',
  'select',
  'key',
  'scroll',
  'drag',
  'activate'
])

let cachedPath: string | null | undefined

/** Path to the agent binary, or null when it was not built into the bundle. */
export function agentBinary(): string | null {
  if (cachedPath !== undefined) return cachedPath
  const candidates = resourceCandidates(BINARY_NAME, [
    // A dev checkout that built the sidecar with `npm run build:agent` has it
    // here, next to the sources rather than in `resources/`.
    join(app.getAppPath(), 'native', 'deskhand', '.build', 'release', BINARY_NAME)
  ])
  cachedPath = candidates.find((candidate) => existsSync(candidate)) ?? null
  if (!cachedPath) console.warn('[agent] deskhand-agent not found; run `npm run build:agent`')
  return cachedPath
}

/** Everything the agent needs to reach the model the user configured. */
export interface AgentProvider {
  /** `openai` speaks chat-completions, `anthropic` speaks messages. */
  wire: 'openai' | 'anthropic'
  baseUrl: string
  model: string
  apiKey: string
  maxTokens: number
  temperature: number
  /** Extra request-body fields from the settings, merged as they are. */
  extraBody?: Record<string, unknown>
  /** Gateway headers, e.g. OpenRouter's attribution pair. */
  headers?: Record<string, string>
}

export interface AgentRunOptions {
  task: string
  traceRunId?: string
  provider: AgentProvider
  maxSteps: number
  /** Let the agent append an accessibility diff to the last call of a batch. */
  verifyActions: boolean
  /**
   * Ask the agent to describe each action before it runs, so the host can draw
   * it. The action itself is unchanged: this only adds a picture to the pipe.
   */
  visualize: boolean
  /** Bundle ids the agent must never read or act on. */
  excludedApps: string[]
}

/**
 * Where one tool call spent its time.
 *
 * The three phases have three different fixes — the accessibility walk is IPC,
 * the capture is ScreenCaptureKit, the encode is PNG compression — so a single
 * "the click took 1.9 s" number says nothing about what to change. Fields are
 * absent when the phase did not run, which is not the same as taking 0 ms.
 */
export interface AgentToolTiming {
  /** Total wall time of the call. */
  wallMs?: number
  /** Accessibility tree walk. */
  treeMs?: number
  /** Window capture. */
  captureMs?: number
  /** PNG encoding of the captured image. */
  encodeMs?: number
  /** Size of the screenshot handed to the model, before base64. */
  imageBytes?: number
}

/** What one model round trip cost, and what it was asked with. */
export interface AgentStepTiming {
  /** Wall time of the provider call. */
  llmMs: number
  /** Bytes of prompt text after history trimming. */
  promptBytes: number
  /** How many messages survived trimming. */
  history: number
  /** Tool calls the model asked for in this answer. */
  calls: number
  /** Tokens the provider reported, when it reported any. */
  inputTokens?: number
  outputTokens?: number
}

/** The run's totals, emitted once when the loop exits. */
export interface AgentRunReport {
  steps: number
  calls: number
  failedCalls: number
  totalMs: number
  llmMs: number
  toolMs: number
  /** The agent's own timing table, when it was collecting one. */
  table?: string
}

/** What the agent reports while a run is in flight. */
export type AgentSidecarEvent =
  | { kind: 'ready'; tools: number }
  | { kind: 'step'; step: number; total: number }
  | { kind: 'modelTrace'; event: string; data: Record<string, unknown> }
  | { kind: 'stepTiming'; step: number; timing: AgentStepTiming }
  /**
   * The model's prose so far, while the turn is still running.
   *
   * `text` is the whole prefix, not a delta: the card replaces its caption
   * instead of keeping a buffer, and a dropped line costs a word rather than
   * the sentence.
   */
  | { kind: 'stream'; step: number; text: string }
  | { kind: 'narration'; step: number; text: string }
  | { kind: 'tool'; step: number; name: string; args: Record<string, unknown>; narration?: string }
  /**
   * One action, in screen terms, just before it runs.
   *
   * Separate from `tool` because `tool` carries the model's arguments and this
   * carries the resolved target. The host draws this; it must not wait for the
   * drawing before the next event arrives.
   */
  | { kind: 'present'; presentation: AgentPresentation }
  | {
      kind: 'result'
      step: number
      name: string
      ok: boolean
      text: string
      timing: AgentToolTiming
    }
  | { kind: 'approval'; request: AgentToolRequest }
  /**
   * The loop guard fired, and the run continues.
   *
   * Not a stop: the model is told what it did wrong and gets the next step to
   * recover. Kept as its own event so a warned run that then succeeds is not
   * recorded as one that was abandoned.
   */
  | { kind: 'warning'; reason: string }
  | { kind: 'stopped'; reason: string }
  | { kind: 'runReport'; report: AgentRunReport }
  /**
   * The run ended. `complete` is the loop's own verdict.
   *
   * Not inferred from `answer`: the loop returns a closing sentence on every
   * path, including the one where it ran out of steps, so the text alone cannot
   * distinguish "finished" from "gave up". A host that guessed from the sentence
   * drew a checkmark over a task that had not been done.
   */
  | { kind: 'done'; answer: string; complete: boolean }
  | { kind: 'cancelled' }
  | { kind: 'error'; message: string; code?: string }

interface PendingRequest {
  resolve(value: Record<string, unknown>): void
  reject(error: Error): void
}

/** One newline-delimited request, ready for the pipe. */
function requestLine(id: number, method: string, params: Record<string, unknown>): string {
  return `${JSON.stringify({ id, method, params })}\n`
}

export interface Message {
  trace_run_id?: string
  id?: number
  event?: string
  params?: Record<string, unknown>
  result?: Record<string, unknown>
  error?: { message?: string }
}

/**
 * One long-lived agent process.
 *
 * Long-lived rather than one per task because a run is not the only thing that
 * crosses the pipe: a stop, a permission question and the user's answer to a
 * confirmation all arrive while the agent is mid-task, and a stop that had to
 * find a new process id every time would be a stop that misses.
 */
export class AgentSidecar {
  private child: ChildProcessWithoutNullStreams | null = null
  private buffer = ''
  private traceRunId: string | undefined
  private counter = 0
  private readonly pending = new Map<number, PendingRequest>()
  private handlers: ((event: AgentSidecarEvent) => void)[] = []
  private starting: Promise<void> | null = null
  /**
   * Stops requested by the host, counted so a run can tell its own stop from an
   * earlier one.
   *
   * A stop often arrives while the process is still starting: the first run
   * waits up to ten seconds for `ready`, and `cancel()` has nothing to write to
   * until the spawn has happened. Remembering the request is what keeps that
   * stop from being lost — otherwise the run is written as soon as the pipe
   * opens, into an agent nobody is watching and Escape no longer reaches.
   */
  private cancelCount = 0

  /** Whether a process exists and has not exited. */
  get alive(): boolean {
    return this.child !== null && this.child.exitCode === null
  }

  onEvent(handler: (event: AgentSidecarEvent) => void): () => void {
    this.handlers.push(handler)
    return () => {
      this.handlers = this.handlers.filter((entry) => entry !== handler)
    }
  }

  /**
   * Starts the process if it is not running.
   *
   * Resolves once the agent has announced itself, so a caller never writes a run
   * into a pipe nobody is reading yet.
   */
  async start(): Promise<void> {
    if (this.alive) return
    if (this.starting) return this.starting
    this.starting = this.spawnProcess()
    try {
      await this.starting
    } finally {
      this.starting = null
    }
  }

  private spawnProcess(): Promise<void> {
    const binary = agentBinary()
    if (!binary) {
      return Promise.reject(new Error('Компонент агента не собран. Выполни `npm run build:agent`.'))
    }
    this.buffer = ''
    const child = spawn(binary, ['--serve'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      // A child inherits the app's Accessibility and Screen Recording grants by
      // descent. Nothing else of the environment is needed, and handing it the
      // user's whole shell environment would leak more than the agent needs.
      env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: process.env.HOME ?? '' }
    })
    this.child = child

    /**
     * Settles the handshake once, whichever of the four things happens first:
     * `ready`, a spawn error, the exit, or the timeout.
     *
     * The exit is one of them: a binary that dies before `ready` — a missing
     * dylib, a broken signature, a crash — would otherwise leave the caller
     * waiting out the whole timeout for a process that no longer exists.
     */
    let settleHandshake: (error?: Error) => void = () => {}
    const ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => settleHandshake(new Error(`Агент не ответил за ${START_TIMEOUT_MS / 1000} секунд.`)),
        START_TIMEOUT_MS
      )
      const off = this.onEvent((event) => {
        if (event.kind === 'ready') settleHandshake()
      })
      settleHandshake = (error?: Error) => {
        // The first of the four wins; the rest find this no-op.
        settleHandshake = () => {}
        clearTimeout(timer)
        off()
        if (error) reject(error)
        else resolve()
      }
      child.once('error', (error) => settleHandshake(error))
    })

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => this.receive(chunk))
    // The agent logs its steps to stderr on purpose: it is the one place a run
    // can be watched from outside. It is not part of the protocol.
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      for (const line of chunk.split('\n')) {
        if (line.trim()) trace('agent.log', { line: line.slice(0, MAX_LOG_LINE_CHARS) })
      }
    })
    child.once('exit', (code, signal) => {
      this.child = null
      const message = code === 0 ? 'Агент завершил работу.' : `Агент остановился (${signal ?? code}).`
      // A process that exited before the handshake leaves no pipe to write to:
      // the start fails now rather than after the timeout.
      settleHandshake(new Error(message))
      for (const [, entry] of this.pending) entry.reject(new Error(message))
      this.pending.clear()
      // A run that was in flight when the process died has to end in the card,
      // not sit in `acting` until the user presses Escape.
      if (this.handlers.length > 0) this.emit({ kind: 'error', message })
    })

    return ready
  }

  /** Sends one request and waits for its answer. */
  request(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = REQUEST_TIMEOUT_MS
  ): Promise<Record<string, unknown>> {
    const child = this.child
    if (!child || !this.alive) return Promise.reject(new Error('Агент не запущен.'))
    const id = ++this.counter
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Агент не ответил на «${method}».`))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer)
          resolve(value)
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        }
      })
      child.stdin.write(requestLine(id, method, params))
    })
  }

  /**
   * Starts a task. Resolves when the run is accepted, not when it finishes.
   *
   * A stop that arrived while the process was starting resolves without writing
   * a run: the host has already settled the turn, and a run sent after it would
   * be an agent with no card, no events and no Escape.
   */
  async run(runOptions: AgentRunOptions): Promise<void> {
    const cancelsBefore = this.cancelCount
    await this.start()
    if (this.cancelCount !== cancelsBefore) return
    this.traceRunId = runOptions.traceRunId
    await this.request('run', {
      task: runOptions.task,
      provider: wireProvider(runOptions.provider),
      options: {
        max_steps: runOptions.maxSteps,
        trace_run_id: runOptions.traceRunId,
        verify_actions: runOptions.verifyActions,
        // The app's trace already carries every event; the agent's own stderr is
        // the fallback for a run started outside the app.
        verbose: false,
        timings: true,
        // Presentation only. With this false the same tools run and the same
        // approvals are asked, but nothing is raised or drawn.
        visualize: runOptions.visualize,
        // An absent field on the Swift side means no exclusions, so an older
        // binary keeps working.
        excluded_apps: runOptions.excludedApps
      }
    })
    // A stop can reach the process before this run does. That cancel is a no-op
    // on a process with no active run, so repeat it now that one exists.
    if (this.cancelCount !== cancelsBefore) this.cancel()
  }

  /** Answers a pending confirmation. */
  approve(id: string, allow: boolean, reason?: string): void {
    if (!this.alive) return
    this.child?.stdin.write(requestLine(++this.counter, 'approval', {
      id,
      allow,
      ...(reason ? { reason } : {})
    }))
  }

  /** Stops the run in flight; the process stays up for the next one. */
  cancel(): void {
    this.cancelCount += 1
    if (!this.alive) return
    this.child?.stdin.write(requestLine(++this.counter, 'cancel', {}))
  }

  /** Ends the process; called on quit so no agent outlives the window. */
  dispose(): void {
    const child = this.child
    this.child = null
    if (!child || child.exitCode !== null) return
    try {
      child.stdin.write(requestLine(++this.counter, 'shutdown', {}))
    } catch {
      /* the pipe is already gone */
    }
    // A process that ignored `shutdown` will not answer a polite question
    // either, and it must not survive the app that started it.
    const timer = setTimeout(() => child.kill('SIGKILL'), SHUTDOWN_GRACE_MS)
    child.once('exit', () => clearTimeout(timer))
  }

  /** Feeds raw stdout; splits on newlines and dispatches whole messages. */
  private receive(chunk: string): void {
    this.buffer += chunk
    let newline = this.buffer.indexOf('\n')
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline).trim()
      this.buffer = this.buffer.slice(newline + 1)
      if (line) this.dispatch(line)
      newline = this.buffer.indexOf('\n')
    }
  }

  private dispatch(line: string): void {
    let message: Message
    try {
      message = JSON.parse(line) as Message
    } catch {
      trace('agent.badline', { bytes: line.length })
      return
    }
    if (typeof message.id === 'number') {
      const entry = this.pending.get(message.id)
      if (!entry) return
      this.pending.delete(message.id)
      if (message.error) entry.reject(new Error(message.error.message ?? 'Агент вернул ошибку.'))
      else entry.resolve(message.result ?? {})
      return
    }
    if (message.trace_run_id && message.trace_run_id !== this.traceRunId) return
    const event = translate(message)
    if (event) this.emit(event)
  }

  private emit(event: AgentSidecarEvent): void {
    for (const handler of [...this.handlers]) {
      try {
        handler(event)
      } catch (error) {
        trace('agent.handler', { failed: error instanceof Error })
      }
    }
  }
}

/**
 * The provider settings, in the shape the agent's process reads.
 *
 * Snake_case on the wire because that is what the Swift side parses, and the
 * mapping lives here — at the one place where the two languages meet — rather
 * than being spread across both. A camelCase field silently missing on the other
 * side does not fail loudly; it falls back to the agent's own config file, and
 * the first symptom is a run that dies with "no API key configured" even though
 * the user set one.
 */
function wireProvider(provider: AgentProvider): Record<string, unknown> {
  return {
    wire: provider.wire,
    base_url: provider.baseUrl,
    model: provider.model,
    api_key: provider.apiKey,
    max_tokens: provider.maxTokens,
    temperature: provider.temperature,
    ...(provider.extraBody && Object.keys(provider.extraBody).length > 0
      ? { extra_body: provider.extraBody }
      : {}),
    ...(provider.headers ? { headers: provider.headers } : {})
  }
}

/**
 * One optional numeric field, renamed.
 *
 * Spread into an object so an absent field stays absent: the difference between
 * "the capture did not run" and "the capture took 0 ms" is the difference
 * between a tool that does not screenshot and one that screenshots instantly,
 * and a `0` would erase it.
 */
function optionalNumber(
  params: Record<string, unknown>,
  wire: string,
  local: string
): Record<string, number> {
  const value = params[wire]
  return typeof value === 'number' && Number.isFinite(value) ? { [local]: value } : {}
}

/** One variant of the event union, by its `kind`. */
type EventOf<Kind extends AgentSidecarEvent['kind']> = Extract<AgentSidecarEvent, { kind: Kind }>

/** The numeric parameter, or 0 when the agent sent something else. */
function numberParam(params: Record<string, unknown>, key: string): number {
  const value = params[key]
  return typeof value === 'number' ? value : 0
}

/** The string parameter, or '' when the agent sent something else. */
function textParam(params: Record<string, unknown>, key: string): string {
  const value = params[key]
  return typeof value === 'string' ? value : ''
}

/**
 * A flag the agent sends only when it is false.
 *
 * Absent means success on this wire: an older binary that does not send the
 * field is still describing a call that worked, or a run that ended. Reading
 * absence as failure would turn every such call into an error.
 */
function notFalse(value: unknown): boolean {
  return value !== false
}

/**
 * One screen rectangle, or `undefined` when the agent did not send a usable one.
 *
 * Kept as `undefined` rather than a zero rect: "no element to point at" and "an
 * element at 0,0 with no size" are different pictures.
 */
function screenRectParam(value: unknown): ScreenRect | undefined {
  if (!value || typeof value !== 'object') return undefined
  const raw = value as Record<string, unknown>
  const x = raw.x
  const y = raw.y
  const width = raw.width
  const height = raw.height
  if (
    typeof x !== 'number' || !Number.isFinite(x) ||
    typeof y !== 'number' || !Number.isFinite(y) ||
    typeof width !== 'number' || !Number.isFinite(width) ||
    typeof height !== 'number' || !Number.isFinite(height)
  ) {
    return undefined
  }
  return { x, y, width, height }
}

/** A call the model made, with the arguments it asked for. */
function translateTool(params: Record<string, unknown>): EventOf<'tool'> {
  return {
    kind: 'tool',
    step: numberParam(params, 'step'),
    name: textParam(params, 'name'),
    args: (params.arguments as Record<string, unknown>) ?? {},
    narration: textParam(params, 'narration') || undefined
  }
}

/** What one model round trip cost. */
function translateStepTiming(params: Record<string, unknown>): EventOf<'stepTiming'> {
  return {
    kind: 'stepTiming',
    step: numberParam(params, 'step'),
    timing: {
      llmMs: numberParam(params, 'llm_ms'),
      promptBytes: numberParam(params, 'prompt_bytes'),
      history: numberParam(params, 'history'),
      calls: numberParam(params, 'calls'),
      ...optionalNumber(params, 'input_tokens', 'inputTokens'),
      ...optionalNumber(params, 'output_tokens', 'outputTokens')
    }
  }
}

/** What a call did, and how long each phase of it took. */
function translateResult(params: Record<string, unknown>): EventOf<'result'> {
  return {
    kind: 'result',
    step: numberParam(params, 'step'),
    name: textParam(params, 'name'),
    ok: notFalse(params.ok),
    text: textParam(params, 'text'),
    timing: {
      ...optionalNumber(params, 'wall_ms', 'wallMs'),
      ...optionalNumber(params, 'tree_ms', 'treeMs'),
      ...optionalNumber(params, 'capture_ms', 'captureMs'),
      ...optionalNumber(params, 'encode_ms', 'encodeMs'),
      ...optionalNumber(params, 'image_bytes', 'imageBytes')
    }
  }
}

/** The run's totals. */
function translateRunReport(params: Record<string, unknown>): EventOf<'runReport'> {
  return {
    kind: 'runReport',
    report: {
      steps: numberParam(params, 'steps'),
      calls: numberParam(params, 'calls'),
      failedCalls: numberParam(params, 'failed_calls'),
      totalMs: numberParam(params, 'total_ms'),
      llmMs: numberParam(params, 'llm_ms'),
      toolMs: numberParam(params, 'tool_ms'),
      table: textParam(params, 'table') || undefined
    }
  }
}

/** A question the agent is blocked on. */
function translateApproval(params: Record<string, unknown>): EventOf<'approval'> {
  return {
    kind: 'approval',
    request: {
      id: textParam(params, 'id'),
      tool: textParam(params, 'tool'),
      arguments: (params.arguments as Record<string, unknown>) ?? {},
      fingerprint: textParam(params, 'fingerprint'),
      app: textParam(params, 'app') || undefined,
      bundleId: textParam(params, 'bundle_id') || undefined,
      role: textParam(params, 'role') || undefined,
      title: textParam(params, 'title') || undefined,
      label: textParam(params, 'label') || undefined,
      textField: params.text_field === true,
      narration: textParam(params, 'narration') || undefined
    }
  }
}

/** One action in screen terms, just before it runs. */
function translatePresent(params: Record<string, unknown>): EventOf<'present'> {
  const gesture = textParam(params, 'gesture')
  return {
    kind: 'present',
    presentation: {
      tool: textParam(params, 'tool'),
      // An unknown gesture falls back to a click rather than dropping the
      // event: a new tool should still show a pointer, not disappear.
      gesture: GESTURES.has(gesture) ? (gesture as AgentGesture) : 'click',
      app: textParam(params, 'app') || undefined,
      bundleId: textParam(params, 'bundle_id') || undefined,
      pid: typeof params.pid === 'number' ? params.pid : undefined,
      point:
        typeof params.x === 'number' && typeof params.y === 'number'
          ? { x: params.x, y: params.y }
          : undefined,
      target: screenRectParam(params.target),
      window: screenRectParam(params.window)
    }
  }
}

/** A failure the loop reports instead of a run. */
function translateError(params: Record<string, unknown>): EventOf<'error'> {
  return {
    kind: 'error',
    message: textParam(params, 'message'),
    code: textParam(params, 'code') || undefined
  }
}

/**
 * Turns one protocol line into the shape the app thinks in.
 *
 * One case per family of events; the bulky payloads are built by the functions
 * above so this stays a table of the protocol rather than its implementation.
 *
 * Exported for the transcript test: the protocol is a contract between two
 * languages, and the only honest way to check the TypeScript half is to feed it
 * what the Swift half actually wrote.
 */
export function translate(message: Message): AgentSidecarEvent | null {
  const params = message.params ?? {}
  switch (message.event) {
    case 'ready':
      return { kind: 'ready', tools: numberParam(params, 'tools') }
    case 'model-request':
    case 'model-response':
    case 'model-completion':
    case 'model-error':
      return { kind: 'modelTrace', event: message.event, data: params }
    case 'step':
      return {
        kind: 'step',
        step: numberParam(params, 'step'),
        total: numberParam(params, 'total')
      }
    case 'stream':
      return {
        kind: 'stream',
        step: numberParam(params, 'step'),
        text: textParam(params, 'text')
      }
    case 'narration':
      return {
        kind: 'narration',
        step: numberParam(params, 'step'),
        text: textParam(params, 'text')
      }
    case 'tool':
      return translateTool(params)
    case 'step-timing':
      return translateStepTiming(params)
    case 'result':
      return translateResult(params)
    case 'run-report':
      return translateRunReport(params)
    case 'approval':
      return translateApproval(params)
    case 'present':
      return translatePresent(params)
    case 'warning':
      return { kind: 'warning', reason: textParam(params, 'reason') }
    case 'stopped':
      return { kind: 'stopped', reason: textParam(params, 'reason') }
    case 'done':
      return {
        kind: 'done',
        answer: textParam(params, 'answer'),
        complete: notFalse(params.complete)
      }
    case 'cancelled':
      return { kind: 'cancelled' }
    case 'error':
      return translateError(params)
    default:
      return null
  }
}
