import type { ActiveAppInfo, ContextFlags, ContextSnapshot, ScreenshotInfo } from '@shared/types'
import { sameObservedWindow } from '../agent/observation'
import { timed, trace } from '../agent/trace'
import { captureScreenshot } from '../context/screenshot'
import { sameScreenRect } from '../layerWindow'
import {
  helperFrontApplication,
  helperFrontWindow,
  helperVisibleBundleIds,
  helperWindow,
  type RawFrontApp
} from '../native/helper'
import { getSettings } from '../settings/store'
import { delay } from '../util'
import { captureTargetFor } from './captureTarget'
import type { OverlayHost } from './host'

interface CaptureSession {
  id: string
  target: ActiveAppInfo | null
  snapshot: Pick<ContextSnapshot, 'screenshot' | 'screenshotPending'>
  flags: Pick<ContextFlags, 'includeScreenshot'>
  abort: AbortController | null
}

interface CaptureHost<T> {
  window: OverlayHost['window']
  isCurrent(target: T): boolean
  publishContext(target: T): void
  hasAnnotations(target: T): boolean
  onCaptureUnavailable(): void
}

/** How often the open overlay re-captures the screen behind it. */
const LIVE_REFRESH_MS = 2000

/**
 * A shot younger than this still represents "this screen right now". A question
 * asked in the same instant as a live tick reuses it instead of paying for a
 * second capture.
 */
const MAX_SHOT_AGE_MS = 600

/** Time the compositor needs to start excluding the card from screen captures. */
const CONTENT_PROTECTION_SETTLE_MS = 45

export function createLiveCapture<T extends CaptureSession>({
  window,
  isCurrent,
  publishContext,
  hasAnnotations,
  onCaptureUnavailable
}: CaptureHost<T>) {
  const timers = new WeakMap<T, NodeJS.Timeout>()
  const liveInFlight = new WeakSet<T>()

  /** The capture a live tick and a question may be sharing right now. */
  let captureInFlight: { sessionId: string; promise: Promise<ScreenshotInfo | null> } | null = null

  const observedApps = new WeakMap<ScreenshotInfo, RawFrontApp>()

  /**
   * Is the window that was observed still the same window?
   *
   * The question is asked about the *observed* application, and it has to be
   * asked that way round. Whether this app's own card happened to be frontmost
   * when the shutter opened is irrelevant: the card is shown by the app that is
   * taking the picture, it is never the window being acted on, and it takes
   * focus somewhere between the capture and this check. Comparing the observed
   * app against "whatever is frontmost now" therefore compared Chrome against
   * the overlay and reported a window change on every single run — which is
   * exactly the bug that made «открой телеграм» fail five times in a row.
   *
   * So: if the front is this app, read the background window of the observed
   * process and compare that. If the front is the observed app, compare the
   * front. Anything else is a genuine change and is rejected.
   */
  async function windowStillMatches(observed: RawFrontApp): Promise<boolean> {
    // Only the identity of the frontmost app is needed to choose a branch; its
    // window is read below only when that branch needs one. Reading the full
    // `front` here cost a cold Accessibility round trip on every comparison, and
    // a comparison happens several times per capture.
    const front = await helperFrontApplication()
    const background = front?.pid === process.pid ? await helperWindow(observed.pid) : front
    const same = sameObservedWindow(observed, background)
    // Which field disagreed, without recording what was on screen: a window
    // title is the name of the user's own document, so the trace keeps the
    // verdict and the pids and leaves the text out.
    const backgroundBounds = background?.bounds
    const observedBounds = observed.bounds
    trace('screen.compare', {
      same,
      frontPid: front?.pid ?? null,
      observedPid: observed.pid,
      backgroundPid: background?.pid ?? null,
      observedHasWindowId: observed.windowId !== null,
      backgroundHasWindowId: (background?.windowId ?? null) !== null,
      titleMatches: (observed.windowTitle ?? null) === (background?.windowTitle ?? null),
      // A missing rectangle on either side never matches; `sameScreenRect`
      // compares the two as they are, without rounding.
      boundsMatch: backgroundBounds ? sameScreenRect(observedBounds, backgroundBounds) : false,
      selfPid: process.pid
    })
    if (!same) return false
    // Nothing may steal focus while the tree is read: a window that came forward
    // between the two reads is a screen that no longer matches the picture.
    const after = await helperFrontApplication()
    return after?.pid === process.pid || after?.pid === observed.pid
  }

  /**
   * Takes a new picture of the screen *right now*.
   *
   * Normally the whole display, not the active window: the drawing tool has to
   * be able to point at the menu bar, the Dock or a second app, and a
   * window-sized capture would make those targets impossible to show. The
   * painting layer is pinned over exactly the rectangle recorded in
   * `ScreenshotInfo.area`, so display-wide coordinates stay honest.
   *
   * With excluded apps configured the display is safe only while none of them
   * has a window on screen; once one does, or when that cannot be checked, the
   * capture is limited to the observed window and never falls back to the whole
   * screen (`captureTargetFor`).
   *
   * The overlay's own window is temporarily excluded from the capture: without
   * that, the `-R` / full-screen fallbacks would photograph our own card, and a
   * live refresh would end up feeding the model a picture of the assistant.
   * The flag is restored immediately, so the window stays screen-shareable.
   * Concurrent callers (live tick + a question asked at the same moment) share
   * one capture instead of queueing two.
   */
  function captureFor(target: T): Promise<ScreenshotInfo | null> {
    if (captureInFlight) {
      if (captureInFlight.sessionId === target.id) {
        trace('screen.captureJoined')
        return captureInFlight.promise
      }
      const next = (): Promise<ScreenshotInfo | null> | null => (isCurrent(target) ? captureFor(target) : null)
      return captureInFlight.promise.then(next, next)
    }

    const entry = { sessionId: target.id, promise: captureNow(target) }
    captureInFlight = entry
    const clear = (): void => {
      if (captureInFlight === entry) captureInFlight = null
    }
    void entry.promise.then(clear, clear)
    return entry.promise
  }

  /** One capture: shutter, observation check, and the session's new picture. */
  async function captureNow(target: T): Promise<ScreenshotInfo | null> {
    const win = window()
    const visible = Boolean(win && !win.isDestroyed() && win.isVisible())
    const settings = getSettings()
    try {
      if (visible && win) {
        win.setContentProtection(true)
        await delay(CONTENT_PROTECTION_SETTLE_MS)
      }
      // The front window is read even when the agent is off if exclusions are
      // configured: otherwise a window the user switched to could never be
      // checked against the list before the shutter opens. The visible apps are
      // read in parallel and only when exclusions exist: with none configured
      // the whole display is always safe, so that call would be pure cost.
      const excludedApps = settings.excludedApps
      const [front, visibleBundleIds] = await Promise.all([
        settings.agent.enabled || excludedApps.length > 0 ? helperFrontWindow() : Promise.resolve(null),
        excludedApps.length > 0 ? helperVisibleBundleIds() : Promise.resolve(null)
      ])
      const underOverlay = front?.pid === process.pid
      // Under our own card the frontmost window is not the one being acted on:
      // read the remembered target's window instead.
      const observed = underOverlay ? (target.target ? await helperWindow(target.target.pid) : null) : front
      const capture = captureTargetFor({
        observed,
        remembered: target.target,
        excludedApps,
        visibleBundleIds
      })
      if (!capture) {
        // Nothing may be photographed, so the session has no picture any more.
        // The card is still showing the last one and has to be told, or its
        // thumbnail keeps promising a frame the model will never receive.
        target.snapshot.screenshot = null
        target.snapshot.screenshotPending = false
        // The shapes were measured against that frame: keeping them would leave
        // an arrow pointing at a screen that is no longer shown.
        if (isCurrent(target)) onCaptureUnavailable()
        publishContext(target)
        return null
      }
      const shot = await timed('screen.capture', () =>
        captureScreenshot(capture, { maxSide: settings.screenshotMaxSide, quality: settings.screenshotQuality })
      )
      if (shot && observed) {
        if (await windowStillMatches(observed)) {
          observedApps.set(shot, observed)
        }
        // The comparison above already recorded which field disagreed; this
        // line records only that the shot was dropped, without the window text.
        else trace('screen.observationRejected', { reason: 'window-changed-during-capture' })
      }
      if (isCurrent(target)) {
        if (shot) target.snapshot.screenshot = shot
        target.snapshot.screenshotPending = false
        publishContext(target)
      }
      return shot
    } finally {
      if (visible && win && !win.isDestroyed()) win.setContentProtection(false)
    }
  }

  /**
   * Returns an image recent enough to represent "this screen right now". A shot
   * younger than `MAX_SHOT_AGE_MS` is reused so a question asked in the same
   * instant as a live tick does not pay for a second capture; anything older is
   * re-taken, because the whole point is that the model sees the screen as it is
   * now and not as it was when the overlay opened.
   *
   * A refresh that fails yields `null`, never the previous frame: after a Screen
   * Recording refusal the old picture would be presented as the current screen
   * and the prompt would describe it as such, so the model would confidently
   * answer about a minutes-old one. The turn knows how to go on without an image.
   */
  async function ensureFreshScreenshot(target: T, requireObserved = false): Promise<ScreenshotInfo | null> {
    const current = target.snapshot.screenshot
    if (
      current &&
      Date.now() - current.capturedAt < MAX_SHOT_AGE_MS &&
      (!requireObserved || observedApps.has(current))
    ) {
      trace('screen.cacheHit', { ageMs: Date.now() - current.capturedAt })
      return current
    }
    // Only advertise "capturing…" when there is nothing to show yet: a refresh of
    // an existing preview must not flicker the chip on every question.
    const showPending = !current
    if (showPending) {
      target.snapshot.screenshotPending = true
      publishContext(target)
    }
    // `captureFor` publishes the settled context itself, including the cleared
    // state when nothing may be photographed. Sending it again here would make
    // the card redraw the same frame twice.
    return captureFor(target)
  }

  /** Re-captures on a timer while the card is on screen. */
  function startLive(target: T): void {
    if (timers.has(target)) return
    const timer = setInterval(() => {
      if (!isCurrent(target)) {
        stopLive(target)
        return
      }
      // The card is hidden: nothing to preview and
      // nothing that could be asked about, so idle instead of capturing the screen
      // every couple of seconds in the background.
      const win = window()
      if (!win || win.isDestroyed() || !win.isVisible()) {
        stopLive(target)
        return
      }
      // A capture during streaming would only compete with the answer for the
      // main thread; the send path already refreshed the image.
      if (liveInFlight.has(target) || target.abort) return
      if (captureInFlight && captureInFlight.sessionId === target.id) return
      // Nothing to preview when the screenshot chip is off: a capture nobody asked
      // for would just spend battery. The drawing tool needs that image, so the
      // chip is the only switch that decides.
      if (!target.flags.includeScreenshot) return
      // While shapes are on screen a re-capture would swap the image the drawings
      // were measured against; their coordinates are already fixed to it.
      if (hasAnnotations(target)) return
      // Only re-capture when the previous frame is ageing out. A tick that lands
      // right after a request-time refresh would otherwise take a redundant shot.
      const current = target.snapshot.screenshot
      if (current && Date.now() - current.capturedAt < LIVE_REFRESH_MS / 2) return
      liveInFlight.add(target)
      void captureFor(target).finally(() => {
        liveInFlight.delete(target)
      })
    }, LIVE_REFRESH_MS)
    timers.set(target, timer)
  }

  function stopLive(target: T): void {
    const timer = timers.get(target)
    if (timer) clearInterval(timer)
    timers.delete(target)
  }

  return {
    ensureFreshScreenshot,
    startLive,
    stopLive,
    windowStillMatches,
    observedAppFor: (shot: ScreenshotInfo) => observedApps.get(shot)
  }
}
