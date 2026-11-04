/**
 * Long-lived push-to-talk listener around the native helper's `voice` command.
 *
 * The helper owns a CGEventTap and prints one JSON line per edge (`press`,
 * `release`, `cancel`, `ready`, `reenabled`). This module turns that stream into
 * a typed callback and keeps the process alive: macOS can disable a tap after a
 * timeout, and the key combination can change in the settings window, so the
 * child is started, restarted and stopped from here — nowhere else.
 *
 * The process half (spawn, JSON lines, restarts, backoff) lives in
 * `native/tapListener.ts` and is shared with `gesture/listen.ts`. Everything
 * below is what only the keyboard tap does: the accelerator table, the argument
 * list, the «Универсальный доступ» texts and forgetting the accelerator on stop.
 */

import { FUNCTION_CODES, VOICE_KEY_CODES as KEY_CODES } from '@shared/keycodes'
import { TapListener } from '../native/tapListener'

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

export class VoiceKeyListener extends TapListener<TapEvent> {
  private current: string | null = null
  /** The combination the running child was started with. */
  private parsed: ParsedAccelerator | null = null

  constructor(private readonly options: VoiceKeyListenerOptions) {
    super(options.binary, options.onEvent, options.onError)
  }

  get accelerator(): string | null {
    return this.current
  }

  protected readonly tag = 'voice'
  protected readonly spawnFailure = 'Не удалось запустить слушатель.'

  protected args(): string[] {
    const parsed = this.parsed
    if (!parsed) return []
    const args = ['voice', String(parsed.keyCode), String(parsed.flags)]
    if (this.options.swallow !== false) args.push('swallow')
    return args
  }

  protected describeError(code: string): string {
    return describeTapError(code)
  }

  protected onSpawnThrown(message: string): void {
    this.options.onError(message)
  }

  protected onExitWithoutReady(): void {
    // The permission is missing; retrying that in a loop would only fill the log.
    this.lastError = 'Слушатель клавиатуры не запустился — проверьте «Универсальный доступ».'
    this.options.onError(this.lastError)
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
    this.current = accelerator
    this.parsed = parsed
    this.startTap()
    return null
  }

  /** Stops the tap and forgets the accelerator; the helper is signalled. */
  override stop(): void {
    super.stop()
    this.current = null
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
