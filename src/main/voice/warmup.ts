import { getSettings } from '../settings/store'
import { cancelWarmRecognizer, voiceStatus, warmRecognizer } from './recognizer'

/**
 * How long after the tap comes up the recognizer is loaded in the background.
 *
 * Long enough that the launch itself — the card, the tray, the first paint — is
 * never competing with a 175 MB model for disk and CPU; short enough that a user
 * who reaches for the hotkey right after opening the app still finds it warm.
 * A press before this fires cancels the warm-up, because the phrase itself is
 * about to do the same work.
 */
const WARMUP_DELAY_MS = 3_000
export function createRecognizerWarmup(isIdle: () => boolean) {
  /** Waiting warm-up, if any. */
  let warmTimer: NodeJS.Timeout | null = null
  /** The model `warmTimer` belongs to, so a model change can replace it. */
  let warmTimerFor: string | null = null
  /**
   * The model whose warm-up is running right now, if any.
   *
   * Kept apart from `warmedModel` because a load that is interrupted proves
   * nothing: cancelling it has to forget the mark it was going to earn.
   */
  let warmingModel: string | null = null
  /**
   * The model the recognizer has been loaded for.
   *
   * Set only after a warm-up reports that it really loaded the model, and when a
   * real recognition starts: either one has paid for the cold model. Cleared
   * when a warm-up is cancelled, when the selected model changes and on
   * `stop()`, so the next idle moment warms whatever is in force then.
   */
  let warmedModel: string | null = null

  function clearWarmTimer(): void {
    if (warmTimer) clearTimeout(warmTimer)
    warmTimer = null
    warmTimerFor = null
  }

  /**
   * Loads the recognizer in the background, once per model.
   *
   * Recognition starts only after the key is released, so the first phrase of a
   * session used to pay the whole cold start — process, model, compute backend —
   * after the user had already stopped talking. This moves that work to the idle
   * moment after launch instead; a press cancels it (see `onPress`) so the two
   * never run at once.
   */
  function scheduleWarmup(delayMs = WARMUP_DELAY_MS): void {
    const voice = getSettings().voice
    if (!voice.enabled) {
      stopWarmup()
      warmedModel = null
      return
    }
    if (warmedModel === voice.model || warmingModel === voice.model) return
    if (warmTimer && warmTimerFor === voice.model) return
    clearWarmTimer()
    warmTimerFor = voice.model
    warmTimer = setTimeout(() => {
      warmTimer = null
      warmTimerFor = null
      void warmNow()
    }, delayMs)
  }

  /**
   * Runs one warm-up, and remembers it only when it really loaded the model.
   *
   * `warmRecognizer` answers whether the recognizer actually ran. Marking the
   * model before that answer was what made one cancelled warm-up poison every
   * later one: the flag said "warm" while nothing had been loaded.
   */
  async function warmNow(): Promise<void> {
    const model = getSettings().voice.model
    // A phrase that is already running is doing the same work and owns the
    // machine: warm the next time the controller is idle.
    if (!warmAvailable()) return
    // Publish the load before the status check, so a press or a settings change
    // that lands during that await can invalidate this attempt and no second
    // warm-up is queued for the same model in the meantime.
    warmingModel = model
    try {
      // A missing binary or model has nothing to load; the settings window
      // already explains it, so a background attempt would only fail silently.
      const status = await voiceStatus().catch(() => null)
      if (warmingModel !== model || !status?.ready || !warmAvailable() || getSettings().voice.model !== model) return
      const loaded = await warmRecognizer()
      if (loaded && getSettings().voice.model === model) warmedModel = model
    } finally {
      if (warmingModel === model) warmingModel = null
    }
  }

  /** Whether a background warm-up may run right now. */
  function warmAvailable(): boolean {
    const voice = getSettings().voice
    return voice.enabled && isIdle()
  }

  /**
   * Stops the warm-up before a phrase uses the same model and CPU.
   *
   * The interrupted load never proved the model is warm, so its mark is dropped:
   * the next idle moment is free to try again.
   */
  function stopWarmup(): void {
    clearWarmTimer()
    cancelWarmRecognizer()
    if (warmingModel === null) return
    if (warmedModel === warmingModel) warmedModel = null
    warmingModel = null
  }

  function updateModel(model: string): void {
    if (warmingModel !== null && warmingModel !== model) stopWarmup()
    if (warmedModel !== null && warmedModel !== model) warmedModel = null
  }

  function markLoaded(model: string): void {
    if (getSettings().voice.model === model) warmedModel = model
  }

  function reset(): void {
    stopWarmup()
    warmedModel = null
  }

  return { scheduleWarmup, stopWarmup, updateModel, markLoaded, reset }
}
