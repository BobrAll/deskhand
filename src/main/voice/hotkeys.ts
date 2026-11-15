import { helperBinary } from '../native/helper'
import { getSettings } from '../settings/store'
import { parseAccelerator, VoiceKeyListener, type TapEvent } from './listen'

/** Which physical hold started the turn: the main hotkey or the dictation one. */
export type VoiceBinding = 'primary' | 'dictation'

/** One hold's tap process, and the last fatal error it reported. */
interface TapBinding {
  listener: VoiceKeyListener | null
  /**
   * Kept beside the listener because a `cancel` after a failed start still has to
   * explain itself, and the two are only ever read together.
   */
  error: string | null
}

interface HotkeyHost {
  handleTapEvent(event: TapEvent, binding: VoiceBinding): void
  onModel(model: string): void
  onDisabled(): void
  onTapsStopped(): void
  onUnavailable(): void
  onTapsReady(): void
}

export function createVoiceHotkeys({
  handleTapEvent,
  onModel,
  onDisabled,
  onTapsStopped,
  onUnavailable,
  onTapsReady
}: HotkeyHost) {
  const taps: Record<VoiceBinding, TapBinding> = {
    primary: { listener: null, error: null },
    dictation: { listener: null, error: null }
  }
  function ensureListener(binding: VoiceBinding, binary: string): VoiceKeyListener {
    const existing = taps[binding].listener
    if (existing) return existing
    const created = new VoiceKeyListener({
      binary,
      swallow: true,
      onEvent: (event) => handleTapEvent(event, binding),
      onError: (message) => {
        taps[binding].error = message
        console.warn('[voice]', message)
      }
    })
    taps[binding].listener = created
    return created
  }

  function listenerError(): string | null {
    return taps.primary.error ?? taps.dictation.error
  }

  /** (Re)starts both taps from the current settings. Safe to call repeatedly. */
  function applySettings(): void {
    const settings = getSettings()
    const binary = helperBinary()
    if (!binary) {
      taps.primary.error = 'Нативный helper не найден — голосовой ввод недоступен.'
      taps.dictation.error = null
      return
    }
    const primary = ensureListener('primary', binary)
    const dictation = ensureListener('dictation', binary)
    onModel(settings.voice.model)
    if (!settings.voice.enabled) {
      // Switching the feature off while the key is down must end the turn, or
      // the field strip and the remembered target stay on screen forever.
      onDisabled()
      primary.stop()
      dictation.stop()
      taps.primary.error = null
      taps.dictation.error = null
      onTapsStopped()
      return
    }
    const primaryError = primary.start(settings.voice.hotkey)
    taps.primary.error = primaryError
    // Two taps on one combination would answer the same press twice. Spellings
    // such as `Control+Alt` and `Alt+Control` are the same chord, so compare the
    // parsed key code and modifier mask, not the raw strings.
    const primaryParsed = parseAccelerator(settings.voice.hotkey)
    const dictationParsed = parseAccelerator(settings.voice.dictationHotkey)
    const shared = Boolean(
      primaryParsed &&
      dictationParsed &&
      primaryParsed.keyCode === dictationParsed.keyCode &&
      primaryParsed.flags === dictationParsed.flags
    )
    if (shared) dictation.stop()
    const dictationError = shared ? null : dictation.start(settings.voice.dictationHotkey)
    taps.dictation.error = dictationError
    if (primaryError && (shared || dictationError)) {
      // Neither hold can start a turn, so loading the model would only take the
      // machine for a feature that cannot be used.
      onUnavailable()
      return
    }
    // A tap is up and the feature is on: warm the renderer now, not on the first
    // key press. This covers a voice mode that was enabled in the settings window
    // during this run as well as the startup path — a window created by the first
    // press would lose that turn's animation and transcript.
    onTapsReady()
  }

  function suspend(): void {
    taps.primary.listener?.stop()
    taps.dictation.listener?.stop()
  }

  function stop(): void {
    taps.primary.listener?.stop()
    taps.dictation.listener?.stop()
    taps.primary.listener = null
    taps.dictation.listener = null
  }

  return { applySettings, listenerError, suspend, stop }
}
