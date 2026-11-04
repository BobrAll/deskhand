/**
 * Long-lived push-to-talk listener around the native helper's `voice` command.
 *
 * The helper owns a CGEventTap and prints one JSON line per edge (`press`,
 * `release`, `cancel`, `ready`, `reenabled`). This module turns that stream into
 * a typed callback and keeps the process alive: macOS can disable a tap after a
 * timeout, and the key combination can change in the settings window, so the
 * child is started, restarted and stopped from here — nowhere else.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { createInterface } from 'node:readline'
import { FUNCTION_CODES, VOICE_KEY_CODES as KEY_CODES } from '@shared/keycodes'

export type TapEvent = 'press' | 'release' | 'cancel' | 'ready' | 'reenabled'

export interface VoiceKeyListenerOptions {
  binary: string
  /** Swallow the combination so it never reaches the frontmost application. */
  swallow?: boolean
  onEvent(event: TapEvent): void
  /** Fatal problems only: the combination is unusable or the tap was refused. */
  onError(message: string): void
}

const MODIFIER_FLAGS: Record<string, number> = {
  // kCGEventFlagMaskCommand / kCGEventFlagMaskShift / Control / Alternate
  command: 0x00100000,
  cmd: 0x00100000,
  control: 0x00040000,
  ctrl: 0x00040000,
  alt: 0x00080000,
  option: 0x00080000,
  shift: 0x00020000
}

export interface ParsedAccelerator {
  keyCode: number
  flags: number
}

/**
 * Converts an Electron accelerator ("Alt+Shift+Space") into the key code and
 * modifier mask the tap needs. Returns null when the combination cannot be
 * tapped, so the caller can say so instead of binding something half-working.
 */
export function parseAccelerator(accelerator: string): ParsedAccelerator | null {
  const parts = accelerator
    .split('+')
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean)
  if (parts.length < 2) return null

  let flags = 0
  let keyCode: number | null = null

  for (const part of parts) {
    const modifier = MODIFIER_FLAGS[part]
    if (modifier !== undefined) {
      flags |= modifier
      continue
    }
    if (keyCode !== null) return null

    if (KEY_CODES[part] !== undefined) {
      keyCode = KEY_CODES[part]
    } else {
      const fn = /^f(\d{1,2})$/.exec(part)
      if (fn) keyCode = FUNCTION_CODES[Number(fn[1])] ?? null
    }
  }

  if (keyCode === null || flags === 0) return null
  return { keyCode, flags }
}

interface HelperLine {
  ok?: boolean
  event?: TapEvent
  error?: string
}

export class VoiceKeyListener {
  private child: ChildProcess | null = null
  private current: string | null = null
  private stopped = true
  private restartTimer: NodeJS.Timeout | null = null
  private failures = 0
  /** Set when the tap could not start; surfaced in the settings window. */
  lastError: string | null = null

  constructor(private readonly options: VoiceKeyListenerOptions) {}

  /** True while the helper process is up. */
  get listening(): boolean {
    return this.child !== null && !this.child.killed
  }

  get accelerator(): string | null {
    return this.current
  }

  /**
   * Starts (or replaces) the listener. Returns an error message when the
   * combination is unusable, so the settings window can show it right away.
   */
  start(accelerator: string): string | null {
    const parsed = parseAccelerator(accelerator)
    if (!parsed) return `Комбинация «${accelerator}» не подходит для удержания.`
    if (this.listening && this.current === accelerator) return null

    this.stop()
    this.stopped = false
    this.current = accelerator
    this.failures = 0
    this.launch(parsed)
    return null
  }

  private launch(parsed: ParsedAccelerator): void {
    const args = ['voice', String(parsed.keyCode), String(parsed.flags)]
    if (this.options.swallow !== false) args.push('swallow')

    let child: ChildProcess
    try {
      child = spawn(this.options.binary, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      this.options.onError(error instanceof Error ? error.message : 'Не удалось запустить слушатель.')
      return
    }
    this.child = child

    const reader = createInterface({ input: child.stdout! })
    let reportedReady = false

    reader.on('line', (line) => {
      const text = line.trim()
      if (!text) return
      let payload: HelperLine
      try {
        payload = JSON.parse(text) as HelperLine
      } catch {
        return
      }
      if (payload.error) {
        this.lastError = describeTapError(payload.error)
        this.options.onError(this.lastError)
        return
      }
      if (payload.event === 'ready') {
        reportedReady = true
        this.failures = 0
        this.lastError = null
      }
      if (payload.event) this.options.onEvent(payload.event)
    })

    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString().trim()
      if (text) console.warn('[voice] listener:', text.split('\n')[0])
    })

    child.on('exit', (code) => {
      reader.close()
      if (this.child === child) this.child = null
      if (this.stopped) return
      // A start that never reported `ready` means the permission is missing;
      // retrying that in a loop would only fill the log.
      if (!reportedReady) {
        this.lastError = 'Слушатель клавиатуры не запустился — проверьте «Универсальный доступ».'
        this.options.onError(this.lastError)
        return
      }
      console.warn(`[voice] listener exited with ${code}; restarting`)
      this.scheduleRestart(parsed)
    })

    child.on('error', (error) => {
      if (this.child === child) this.child = null
      if (this.stopped) return
      this.lastError = error.message
      this.options.onError(error.message)
      this.scheduleRestart(parsed)
    })
  }

  private scheduleRestart(parsed: ParsedAccelerator): void {
    if (this.stopped || this.restartTimer) return
    this.failures += 1
    if (this.failures > 6) return
    // 1s, 2s, 4s… capped at 30s: long enough not to spin, short enough that a
    // permission granted mid-session revives the hotkey without a restart.
    const delayMs = Math.min(30_000, 1000 * 2 ** (this.failures - 1))
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      if (!this.stopped) this.launch(parsed)
    }, delayMs)
  }

  /** Stops the tap. The helper blocks in a run loop, so it has to be signalled. */
  stop(): void {
    this.stopped = true
    if (this.restartTimer) {
      clearTimeout(this.restartTimer)
      this.restartTimer = null
    }
    this.current = null
    if (this.child) {
      this.child.kill('SIGTERM')
      this.child = null
    }
  }
}

function describeTapError(code: string): string {
  if (code === 'accessibility-denied') {
    return 'Нет доступа «Универсальный доступ» — удержание клавиши не работает.'
  }
  if (code === 'tap-create-failed') {
    return 'Не удалось перехватить клавиатуру: проверьте «Универсальный доступ» и перезапустите приложение.'
  }
  return `Слушатель клавиатуры: ${code}`
}
