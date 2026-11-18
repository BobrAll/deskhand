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
import { resourceCandidates } from '../paths'
import { requestLine, translate, wireProvider } from './sidecarProtocol'
import type { AgentRunOptions, AgentSidecarEvent, Message } from './sidecarProtocol'
import { trace } from './trace'

export { translate } from './sidecarProtocol'
export type {
  AgentProvider,
  AgentRunOptions,
  AgentRunReport,
  AgentSidecarEvent,
  AgentStepTiming,
  AgentToolTiming,
  Message
} from './sidecarProtocol'

const BINARY_NAME = 'deskhand-agent'

/** How long the agent has to announce itself before the start counts as failed. */
const START_TIMEOUT_MS = 10_000
/** How long one request may wait for its answer. */
const REQUEST_TIMEOUT_MS = 15_000
/** How long a process gets to exit after `shutdown` before it is killed. */
const SHUTDOWN_GRACE_MS = 1_000
/** How much of one stderr line is kept in the trace. */
const MAX_LOG_LINE_CHARS = 300

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

interface PendingRequest {
  resolve(value: Record<string, unknown>): void
  reject(error: Error): void
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
    this.child?.stdin.write(
      requestLine(++this.counter, 'approval', {
        id,
        allow,
        ...(reason ? { reason } : {})
      })
    )
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
