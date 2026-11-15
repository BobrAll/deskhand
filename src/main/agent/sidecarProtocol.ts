import type { AgentGesture, AgentPresentation, AgentToolRequest, ScreenRect } from '@shared/types'

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

export interface Message {
  trace_run_id?: string
  id?: number
  event?: string
  params?: Record<string, unknown>
  result?: Record<string, unknown>
  error?: { message?: string }
}

/** One newline-delimited request, ready for the pipe. */
export function requestLine(id: number, method: string, params: Record<string, unknown>): string {
  return `${JSON.stringify({ id, method, params })}\n`
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
export function wireProvider(provider: AgentProvider): Record<string, unknown> {
  return {
    wire: provider.wire,
    base_url: provider.baseUrl,
    model: provider.model,
    api_key: provider.apiKey,
    max_tokens: provider.maxTokens,
    temperature: provider.temperature,
    ...(provider.extraBody && Object.keys(provider.extraBody).length > 0 ? { extra_body: provider.extraBody } : {}),
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
function optionalNumber(params: Record<string, unknown>, wire: string, local: string): Record<string, number> {
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
    typeof x !== 'number' ||
    !Number.isFinite(x) ||
    typeof y !== 'number' ||
    !Number.isFinite(y) ||
    typeof width !== 'number' ||
    !Number.isFinite(width) ||
    typeof height !== 'number' ||
    !Number.isFinite(height)
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
      point: typeof params.x === 'number' && typeof params.y === 'number' ? { x: params.x, y: params.y } : undefined,
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
