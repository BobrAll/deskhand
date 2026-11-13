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
 * `native/tapListener.ts`. Everything below is what only the keyboard tap does:
 * the accelerator table, the argument list, the «Универсальный доступ» texts and
 * forgetting the accelerator on stop.
 */

import { FUNCTION_CODES, VOICE_KEY_CODES } from '@shared/keycodes'
import { MODIFIER_FLAGS } from '@shared/accelerator'
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

export interface ParsedAccelerator {
  /** `MODIFIER_ONLY` when the combination has no ordinary key. */
  keyCode: number
  flags: number
}

/**
 * A hold made only of modifiers, e.g. Control+Alt.
 *
 * The tap reads it from `flagsChanged` instead of a key edge. Kept as a value
 * the native side can recognize in the same `voice` command it already takes.
 */
export const MODIFIER_ONLY = -1

/**
 * Converts an accelerator ("Alt+Shift+Space") into the key code and modifier
 * mask the tap needs. A hold of two or more modifiers is valid too. Returns null
 * when the combination cannot be tapped, so the caller can say so instead of
 * binding something half-working.
 */
export function parseAccelerator(accelerator: string): ParsedAccelerator | null {
  const parts = accelerator
    .split('+')
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean)
  if (parts.length < 2) return null

  let flags = 0
  const modifiers = new Set<string>()
  let key: string | null = null

  for (const part of parts) {
    const modifier = MODIFIER_FLAGS[part]
    if (modifier !== undefined) {
      flags |= modifier
      modifiers.add(part)
      continue
    }
    if (key !== null) return null
    key = part
  }

  if (flags === 0) return null
  if (key === null) {
    // One modifier alone would fire on every Ctrl or Shift; a pair is a gesture.
    return modifiers.size >= 2 ? { keyCode: MODIFIER_ONLY, flags } : null
  }

  if (VOICE_KEY_CODES[key] !== undefined) return { keyCode: VOICE_KEY_CODES[key], flags }
  const fn = /^f(\d{1,2})$/.exec(key)
  if (fn) {
    const keyCode = FUNCTION_CODES[Number(fn[1])]
    return keyCode === undefined ? null : { keyCode, flags }
  }
  return null
}

export class VoiceKeyListener extends TapListener<TapEvent> {
  private boundAccelerator: string | null = null
  /** The combination the running child was started with. */
  private parsed: ParsedAccelerator | null = null

  constructor(private readonly options: VoiceKeyListenerOptions) {
    super(options.binary, options.onEvent, options.onError)
  }

  get accelerator(): string | null {
    return this.boundAccelerator
  }

  protected readonly tag = 'voice'
  protected readonly spawnFailure = 'Не удалось запустить слушатель.'

  protected args(): string[] {
    const parsed = this.parsed
    if (!parsed) return []
    const args = ['voice', String(parsed.keyCode), String(parsed.flags)]
    // A modifier-only hold has no key edge to swallow, and suppressing a bare
    // modifier would break every ordinary Ctrl or Fn press in the frontmost app.
    if (parsed.keyCode !== MODIFIER_ONLY && this.options.swallow !== false) args.push('swallow')
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
    this.lastError = 'Слушатель клавиатуры не запустился — проверь «Универсальный доступ».'
    this.options.onError(this.lastError)
  }

  /**
   * Starts (or replaces) the listener. Returns an error message when the
   * combination is unusable, so the settings window can show it right away.
   */
  start(accelerator: string): string | null {
    const parsed = parseAccelerator(accelerator)
    if (!parsed) return `Комбинация «${accelerator}» не подходит для удержания.`
    if (this.listening && this.boundAccelerator === accelerator) return null

    this.stop()
    this.boundAccelerator = accelerator
    this.parsed = parsed
    this.startTap()
    return null
  }

  /** Stops the tap and forgets the accelerator; the helper is signalled. */
  override stop(): void {
    super.stop()
    this.boundAccelerator = null
  }
}

function describeTapError(code: string): string {
  if (code === 'accessibility-denied') {
    return 'Нет доступа «Универсальный доступ» — удержание клавиши не работает.'
  }
  if (code === 'tap-create-failed') {
    return 'Не удалось перехватить клавиатуру: проверь «Универсальный доступ» и перезапусти приложение.'
  }
  return `Слушатель клавиатуры: ${code}`
}
