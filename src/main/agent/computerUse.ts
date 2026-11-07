/**
 * Client for `cu-service` — the macOS computer-use service from the separate
 * `computer-use` project.
 *
 * Why a second backend exists at all. The visual path guesses *where* a control
 * is from a downscaled screenshot and then posts a mouse event at the guessed
 * point; a model looking at a picture is routinely twenty to sixty points off,
 * so the guess is corrected against the Accessibility tree and, when that tree
 * cannot answer, used as it is. The service answers a different question: it
 * resolves the control *by what it is* — role, label, identifier — activates it
 * through `AXUIElementPerformAction`, and then waits for the application to
 * actually change. Two consequences, and they are the point of this module:
 *
 * 1. The action lands on the named control or is refused. A control that is not
 *    on the screen is `notFound`, not "clicked approximately"; two controls that
 *    match equally are `ambiguous`, not "picked one".
 * 2. Nothing moves. No cursor warp, no frontmost change: the user keeps typing
 *    in their own window while the assistant works in another one.
 *
 * The service is optional by construction. Every failure here is a typed
 * `CuUnavailable` or `CuRpcError`, and the caller falls back to the coordinate
 * path, so a stopped, missing or untrusted service changes nothing about how the
 * agent behaves — it only loses the upgrade.
 *
 * Transport is JSON-RPC 2.0, newline-delimited, over a Unix socket. One
 * connection per call: `connect` on a socket costs microseconds against an
 * action that takes milliseconds, and a long-lived connection would have to be
 * resurrected after every service restart.
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createConnection } from 'node:net'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** How the caller names an element. Coordinates are deliberately not part of it. */
export interface CuQuery {
  role?: string
  subrole?: string
  identifier?: string
  domIdentifier?: string
  ariaLabel?: string
  title?: string
  value?: string
  /** Case-insensitive substring match on title/label/value. The weakest field. */
  text?: string
  withinDomIdentifier?: string
}

/** What the resolver found, and how strongly. */
export interface CuResolved {
  key: string
  role: string
  strategy: string
  confidence: number
  ambiguous: boolean
  alternatives: number
}

/** One completed action, with the evidence the service collected for it. */
export interface CuActionResult {
  outcome: string
  verified: boolean
  actionId: string
  target: string
  strategy: string
  confidence: number
  attempts: number
  durationMs: number
  dispatcher: string
  notifications: string[]
  /** The two invariants the service exists to hold, reported on every action. */
  cursorMoved: boolean
  frontmostChanged: boolean
  notes: string[]
}

export interface CuHealth {
  service: string
  pid: number
  /** The service inherited Accessibility from its parent; without it, nothing works. */
  trusted: boolean
  screenCapture: boolean
  flags: string
  methods: string[]
}

/** The service is not there, not trusted, or did not answer. Fall back. */
export class CuUnavailable extends Error {
  constructor(message: string, readonly reason: 'missing' | 'transport' | 'timeout') {
    super(message)
    this.name = 'CuUnavailable'
  }
}

/** The service answered with a JSON-RPC error: it is running, the call failed. */
export class CuRpcError extends Error {
  constructor(readonly code: number, message: string, readonly data?: unknown) {
    super(message)
    this.name = 'CuRpcError'
  }
}

/** Error codes this protocol defines, from `RPC.ErrorCode` on the service side. */
export const CU_CODE = {
  notTrusted: -32001,
  appNotFound: -32002,
  resolveFailed: -32003,
  notVerified: -32004,
  disabled: -32005
} as const

/** Standard location, chosen by the service so a shared `/tmp` cannot squat it. */
export function cuSocketPath(): string {
  const override = process.env.SMART_CURSOR_CU_SOCKET?.trim()
  if (override) return override
  return join(homedir(), 'Library', 'Application Support', 'ComputerUse', 'control.sock')
}

/**
 * The service binary, when it was copied next to the app's own helper.
 *
 * Bundling it is a build step (`npm run build:cu`), not a runtime concern: a
 * missing binary means "the service is not installed here", which is a supported
 * configuration, not an error.
 */
export function cuServiceBinary(): string | null {
  const override = process.env.SMART_CURSOR_CU_BINARY?.trim()
  if (override && existsSync(override)) return override
  const candidates = [
    process.resourcesPath ? join(process.resourcesPath, 'cu-service') : '',
    join(process.cwd(), 'resources', 'cu-service')
  ]
  return candidates.find((candidate) => candidate && existsSync(candidate)) ?? null
}

interface RequestOptions {
  timeoutMs?: number
  signal?: AbortSignal
}

function request<T>(
  method: string,
  params: Record<string, unknown>,
  options: RequestOptions = {}
): Promise<T> {
  const socketPath = cuSocketPath()
  const timeoutMs = options.timeoutMs ?? 30_000
  if (options.signal?.aborted) {
    return Promise.reject(new CuUnavailable('call cancelled', 'transport'))
  }
  if (!existsSync(socketPath)) {
    return Promise.reject(new CuUnavailable(`no cu-service socket at ${socketPath}`, 'missing'))
  }

  return new Promise<T>((resolve, reject) => {
    const connection = createConnection({ path: socketPath })
    let buffer = ''
    let settled = false
    const finish = (error: Error | null, value?: T): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
      connection.destroy()
      if (error) reject(error)
      else resolve(value as T)
    }
    const onAbort = (): void => finish(new CuUnavailable('call cancelled', 'transport'))
    const timer = setTimeout(
      () => finish(new CuUnavailable(`cu-service did not answer within ${timeoutMs} ms`, 'timeout')),
      timeoutMs
    )
    options.signal?.addEventListener('abort', onAbort, { once: true })

    connection.setEncoding('utf8')
    connection.on('error', (error: NodeJS.ErrnoException) => {
      finish(new CuUnavailable(`cu-service transport: ${error.message}`, 'transport'))
    })
    connection.on('connect', () => {
      connection.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) + '\n')
    })
    connection.on('data', (chunk: string) => {
      buffer += chunk
      const newline = buffer.indexOf('\n')
      if (newline < 0) return
      let reply: { result?: T; error?: { code?: number; message?: string; data?: unknown } }
      try {
        reply = JSON.parse(buffer.slice(0, newline))
      } catch {
        finish(new CuUnavailable('cu-service sent a line that is not JSON', 'transport'))
        return
      }
      if (reply.error) {
        finish(
          new CuRpcError(
            typeof reply.error.code === 'number' ? reply.error.code : -32603,
            reply.error.message ?? 'cu-service refused the call',
            reply.error.data
          )
        )
        return
      }
      if (reply.result === undefined) {
        finish(new CuUnavailable('cu-service replied without a result', 'transport'))
        return
      }
      finish(null, reply.result)
    })
    connection.on('close', () => {
      // A service that closes before answering is the "restarted under us" case.
      if (!settled) finish(new CuUnavailable('cu-service closed the connection without replying', 'transport'))
    })
  })
}

/** Cached health, so a step that will fall back anyway does not pay a round trip. */
const HEALTH_TTL_MS = 5_000
let healthCache: { at: number; value: CuHealth } | null = null

export function resetCuHealthCache(): void {
  healthCache = null
}

/**
 * Whether the service can act right now.
 *
 * `trusted` is the field that matters. A service started through LaunchServices
 * comes up healthy and useless — accessibility trust is attributed to the
 * responsible process and is not inherited any other way — so a healthy-looking
 * service that cannot read a single element must be treated as absent.
 */
export async function cuHealth(
  options: { fresh?: boolean; signal?: AbortSignal } = {}
): Promise<CuHealth | null> {
  // A test run must never reach the developer's real service: it would act on
  // the applications open on that machine. A test that wants the client points
  // it at its own socket with `SMART_CURSOR_CU_SOCKET` and gets a real one.
  if (process.env.VITEST && !process.env.SMART_CURSOR_CU_SOCKET) return null
  if (!options.fresh && healthCache && Date.now() - healthCache.at < HEALTH_TTL_MS) {
    return healthCache.value
  }
  try {
    const health = await request<CuHealth>('health', {}, { timeoutMs: 3_000, signal: options.signal })
    if (!health?.trusted) {
      healthCache = null
      return null
    }
    healthCache = { at: Date.now(), value: health }
    return health
  } catch {
    healthCache = null
    return null
  }
}

/** Which process this app started, so quitting the app can stop it. */
let spawned: number | null = null

/**
 * A service to talk to, starting one if the binary is installed and none runs.
 *
 * The spawn is deliberate rather than lazy: accessibility trust follows the
 * *responsible* process, so a service started as this app's child inherits this
 * app's grant, while one started through LaunchServices gets nothing. If the
 * app itself is untrusted, the child reports `trusted: false` and the caller
 * falls back — which is the honest outcome, not a broken state.
 */
export async function ensureCuService(
  options: { signal?: AbortSignal } = {}
): Promise<CuHealth | null> {
  const running = await cuHealth({ signal: options.signal })
  if (running) return running
  const binary = cuServiceBinary()
  if (!binary || options.signal?.aborted) return null
  try {
    const child = spawn(binary, [], { detached: true, stdio: 'ignore' })
    child.unref()
    if (typeof child.pid === 'number') spawned = child.pid
  } catch {
    return null
  }
  const deadline = Date.now() + 3_000
  while (Date.now() < deadline) {
    if (options.signal?.aborted) return null
    const health = await cuHealth({ fresh: true, signal: options.signal })
    if (health) return health
    await new Promise((resolve) => setTimeout(resolve, 120))
  }
  return null
}

/** Stops the service only if this app started it; one the user started is theirs. */
export function stopSpawnedCuService(): void {
  if (spawned === null) return
  try {
    process.kill(spawned, 'SIGTERM')
  } catch {
    // Already gone: the socket is unlinked on the way out either way.
  }
  spawned = null
  resetCuHealthCache()
}

/** Resolve one element without touching it. */
export async function cuResolve(
  pid: number,
  query: CuQuery,
  options: RequestOptions & { window?: string } = {}
): Promise<CuResolved> {
  return request<CuResolved>(
    'resolve',
    { pid, query, ...(options.window ? { window: options.window } : {}) },
    { timeoutMs: 8_000, signal: options.signal }
  )
}

export type CuActionKind =
  | { kind: 'press' }
  | { kind: 'focus' }
  | { kind: 'select' }
  | { kind: 'setValue'; value: string }
  /**
   * Focus the element through AX, then type into it.
   *
   * Preferred over `setValue` for text: `setValue` replaces the whole value,
   * while typing inserts at the caret — which is what "впиши адрес" means when
   * the field already holds something.
   */
  | { kind: 'typeText'; text: string }

/**
 * Act on a resolved element and wait for the application to confirm it.
 *
 * The timeout covers the service's own retries and its verification window, so
 * it is generous on purpose: a press on Chromium legitimately takes a second
 * before the DOM reflects it, and giving up early would turn a slow success into
 * a reported failure.
 */
export async function cuAct(
  pid: number,
  query: CuQuery,
  action: CuActionKind,
  options: RequestOptions & { window?: string; attempts?: number } = {}
): Promise<CuActionResult> {
  return request<CuActionResult>(
    'act',
    {
      pid,
      query,
      action,
      ...(options.window ? { window: options.window } : {}),
      ...(options.attempts ? { attempts: options.attempts } : {})
    },
    { timeoutMs: 20_000, signal: options.signal }
  )
}

/**
 * Act on a control named by its label, trying the exact fields before the loose one.
 *
 * The protocol's `text` field is a case-insensitive *substring* match on title,
 * aria-label and value joined together. For a label like «Назад» that matches the
 * toolbar button and every piece of text mentioning it — on a real window, eight
 * candidates — so the resolver refuses as ambiguous and the step falls back to a
 * click. `title` and `ariaLabel` are equality matches at 0.90 and 0.95, and they
 * pick the button out of the same window on the first try.
 *
 * The order is by identity strength, and the loose field is tried last so a
 * control the strict fields cannot express — one whose name lives only in a
 * joined haystack — still gets its chance.
 */
export async function cuActByLabel(
  pid: number,
  label: string,
  action: CuActionKind,
  options: RequestOptions & { window?: string; attempts?: number; role?: string } = {}
): Promise<CuActionResult> {
  const queries: CuQuery[] = [
    { title: label },
    { ariaLabel: label },
    { value: label },
    // The role is a filter rather than a score in the resolver, so it turns the
    // substring match from "every mention" into "every mention inside a button".
    ...(options.role ? [{ text: label, role: options.role }] : []),
    { text: label }
  ]

  let refusal: unknown = null
  for (const query of queries) {
    try {
      const result = await cuAct(pid, query, action, options)
      // `refused` is the service saying it matched nothing — or that policy
      // stopped it before dispatch — and performed nothing either way. That is
      // the one answer worth re-asking with a different way of spelling the same
      // name. Every other outcome means the call reached the element, so it is
      // returned as it stands: `failed` there means the control does not take
      // this action, and another shape would only aim at a different element.
      if (result.outcome === 'refused') {
        refusal = result
        continue
      }
      return result
    } catch (error) {
      // An ambiguity or a miss is the same situation as `refused`: nothing was
      // performed. A timeout, a transport failure or a refusal from the
      // application itself would repeat an action that may already have happened.
      const code = (error as { code?: unknown })?.code
      if (code !== CU_CODE.resolveFailed) throw error
      refusal = error
    }
  }
  // Every shape declined. The caller reads this as "nothing happened" and falls
  // back to the pixel, which is the whole point of asking in the first place.
  if (refusal instanceof Error) throw refusal
  return refusal as CuActionResult
}
