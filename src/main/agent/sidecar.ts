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
import type { AgentToolRequest } from '@shared/types'
import { trace } from './trace'

const BINARY_NAME = 'deskhand-agent'

let cachedPath: string | null | undefined

/** Path to the agent binary, or null when it was not built into the bundle. */
export function agentBinary(): string | null {
  if (cachedPath !== undefined) return cachedPath
  const candidates = app.isPackaged
    ? [join(process.resourcesPath, BINARY_NAME)]
    : [
        join(app.getAppPath(), 'resources', BINARY_NAME),
        join(app.getAppPath(), 'native', 'deskhand', '.build', 'release', BINARY_NAME),
        join(process.cwd(), 'resources', BINARY_NAME)
      ]
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
  /** Gateway headers, e.g. OpenRouter's attribution pair. */
  headers?: Record<string, string>
}

export interface AgentRunOptions {
  task: string
  provider: AgentProvider
  maxSteps: number
  /** Let the agent append an accessibility diff to the last call of a batch. */
  verifyActions: boolean
}

/** What the agent reports while a run is in flight. */
export type AgentSidecarEvent =
  | { kind: 'ready'; tools: number }
  | { kind: 'step'; step: number; total: number }
  | { kind: 'narration'; step: number; text: string }
  | { kind: 'tool'; step: number; name: string; args: Record<string, unknown>; narration?: string }
  | { kind: 'result'; step: number; name: string; ok: boolean; text: string }
  | { kind: 'approval'; request: AgentToolRequest }
  | { kind: 'stopped'; reason: string }
  | { kind: 'done'; answer: string }
  | { kind: 'cancelled' }
  | { kind: 'error'; message: string; code?: string }

interface Pending {
  resolve(value: Record<string, unknown>): void
  reject(error: Error): void
}

export interface Message {
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
  private counter = 0
  private readonly pending = new Map<number, Pending>()
  private handlers: ((event: AgentSidecarEvent) => void)[] = []
  private starting: Promise<void> | null = null

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
      return Promise.reject(new Error('Компонент агента не собран. Выполните `npm run build:agent`.'))
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

    const ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Агент не ответил за 10 секунд.')), 10_000)
      const off = this.onEvent((event) => {
        if (event.kind !== 'ready') return
        clearTimeout(timer)
        off()
        resolve()
      })
      child.once('error', (error) => {
        clearTimeout(timer)
        off()
        reject(error)
      })
    })

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => this.receive(chunk))
    // The agent logs its steps to stderr on purpose: it is the one place a run
    // can be watched from outside. It is not part of the protocol.
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      for (const line of chunk.split('\n')) {
        if (line.trim()) trace('agent.log', { line: line.slice(0, 300) })
      }
    })
    child.once('exit', (code, signal) => {
      this.child = null
      const message = code === 0 ? 'Агент завершил работу.' : `Агент остановился (${signal ?? code}).`
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
    timeoutMs = 15_000
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
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`)
    })
  }

  /** Starts a task. Resolves when the run is accepted, not when it finishes. */
  async run(options: AgentRunOptions): Promise<void> {
    await this.start()
    await this.request('run', {
      task: options.task,
      provider: wireProvider(options.provider),
      options: {
        max_steps: options.maxSteps,
        verify_actions: options.verifyActions,
        // The app's trace already carries every event; the agent's own stderr is
        // the fallback for a run started outside the app.
        verbose: false,
        timings: true
      }
    })
  }

  /** Answers a pending confirmation. */
  approve(id: string, allow: boolean, reason?: string): void {
    if (!this.alive) return
    this.child?.stdin.write(`${JSON.stringify({
      id: ++this.counter,
      method: 'approval',
      params: { id, allow, ...(reason ? { reason } : {}) }
    })}\n`)
  }

  /** Stops the run in flight; the process stays up for the next one. */
  cancel(): void {
    if (!this.alive) return
    this.child?.stdin.write(`${JSON.stringify({ id: ++this.counter, method: 'cancel', params: {} })}\n`)
  }

  /** Ends the process; called on quit so no agent outlives the window. */
  dispose(): void {
    const child = this.child
    this.child = null
    if (!child || child.exitCode !== null) return
    try {
      child.stdin.write(`${JSON.stringify({ id: ++this.counter, method: 'shutdown', params: {} })}\n`)
    } catch {
      /* the pipe is already gone */
    }
    // A process that ignored `shutdown` will not answer a polite question
    // either, and it must not survive the app that started it.
    const timer = setTimeout(() => child.kill('SIGKILL'), 1_000)
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
    ...(provider.headers ? { headers: provider.headers } : {})
  }
}

/**
 * Turns one protocol line into the shape the app thinks in.
 *
 * Exported for the transcript test: the protocol is a contract between two
 * languages, and the only honest way to check the TypeScript half is to feed it
 * what the Swift half actually wrote.
 */
export function translate(message: Message): AgentSidecarEvent | null {
  const params = message.params ?? {}
  const number = (key: string): number => (typeof params[key] === 'number' ? params[key] as number : 0)
  const text = (key: string): string => (typeof params[key] === 'string' ? params[key] as string : '')
  switch (message.event) {
    case 'ready':
      return { kind: 'ready', tools: number('tools') }
    case 'step':
      return { kind: 'step', step: number('step'), total: number('total') }
    case 'narration':
      return { kind: 'narration', step: number('step'), text: text('text') }
    case 'tool':
      return {
        kind: 'tool',
        step: number('step'),
        name: text('name'),
        args: (params.arguments as Record<string, unknown>) ?? {},
        narration: text('narration') || undefined
      }
    case 'result':
      return {
        kind: 'result',
        step: number('step'),
        name: text('name'),
        ok: params.ok !== false,
        text: text('text')
      }
    case 'approval':
      return {
        kind: 'approval',
        request: {
          id: text('id'),
          tool: text('tool'),
          arguments: (params.arguments as Record<string, unknown>) ?? {},
          fingerprint: text('fingerprint'),
          app: text('app') || undefined,
          bundleId: text('bundle_id') || undefined,
          role: text('role') || undefined,
          title: text('title') || undefined,
          label: text('label') || undefined,
          textField: params.text_field === true,
          narration: text('narration') || undefined
        }
      }
    case 'stopped':
      return { kind: 'stopped', reason: text('reason') }
    case 'done':
      return { kind: 'done', answer: text('answer') }
    case 'cancelled':
      return { kind: 'cancelled' }
    case 'error':
      return { kind: 'error', message: text('message'), code: text('code') || undefined }
    default:
      return null
  }
}
