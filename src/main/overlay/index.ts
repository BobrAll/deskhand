/**
 * The overlay session: everything between "hotkey pressed" and "overlay hidden".
 *
 * Flow (ТЗ §4): remember the frontmost app -> collect context -> show the
 * overlay next to the cursor -> stream the answer -> paste / copy / retry / close.
 */

import { createHash, randomUUID } from 'node:crypto'
import { app, BrowserWindow } from 'electron'
import { allowsWebLookup, looksLikeAction } from '@shared/intent'
import { CH } from '@shared/ipc'
import { parseExtraBody, providerInfo, resolveBaseUrl } from '@shared/defaults'
import type {
  ActiveAppInfo,
  AgentAvailability,
  AgentEvent,
  AgentRunResult,
  Annotation,
  AxElementInfo,
  ContextFlags,
  ContextSnapshot,
  OverlayState,
  PasteResult,
  ScreenshotInfo,
  ScreenRect,
  SendRequest,
  StreamEvent,
  StreamEventCode
} from '@shared/types'
import { createAgentController } from '../agent'
import { beginAgentTurn, endAgentTurn, updateAgentCursor } from '../agent/cursor'
import { paintAgentPresentation, updateAgentPresentation } from '../agent/presentation'
import type { AgentProvider } from '../agent/sidecar'
import { describeScreen as readScreenOutline } from '../agent/outline'
import { collectContext } from '../context/collect'
import { isExcluded } from '../context/activeApp'
import { captureScreenshot } from '../context/screenshot'
import { getProvider, resolveChatModel } from '../llm'
import { ProviderError, type ChatMessage } from '../llm/provider'
import { searchWeb } from '../llm/webSearch'
import { CARD_FOLDED_HEIGHT } from '../card'
import { copyText, pasteAnswer } from '../paste'
import { hideAnnotations, showAnnotations } from '../drawing'
import { buildTurnRequest, type Exchange, type TurnRequest } from './request'
import { captureTargetFor } from './captureTarget'
import { readPreviousCommand, saveCommand } from './history'
import { timed, trace, traceTurn } from '../agent/trace'
import { emptyAnswerFallback } from './emptyAnswer'
import { groundAnnotation } from '../annotationGrounding'
import type { OverlayHost } from './host'
import { consumeTurnStream } from '../turnStream'
import { sameObservedWindow } from '../agent/observation'
import {
  helperActivate,
  helperFocused,
  helperFrontApplication,
  helperFrontWindow,
  helperVisibleBundleIds,
  helperWindow,
  type RawFrontApp
} from '../native/helper'
import { getApiKey } from '../settings/secrets'
import { getSettings, patchSettings } from '../settings/store'
import { sameScreenRect } from '../layerWindow'
import { delay } from '../util'

interface CardExchange extends Exchange {
  bundleId: string | null
}

/** Everything the two halves of a turn share. */
interface TurnContext {
  request: SendRequest
  session: Session
  settings: ReturnType<typeof getSettings>
  apiKey: string
  /** The rewrite this turn is, or `null` for a normal question. */
  refine: NonNullable<SendRequest['refine']> | null
  /** The conversation, already filtered against the excluded apps. */
  history: CardExchange[]
  previousCommand: string | undefined
  useHistory: boolean
  availability: AgentAvailability
  abort: AbortController
}

/** What a finished turn leaves on the card, and how the trace names it. */
interface TurnResult {
  answer: string
  outcome: string
  reason: string
  /** The agent reported success without anything to say. */
  acknowledged: boolean
}

interface Session {
  id: string
  snapshot: ContextSnapshot
  flags: ContextFlags
  /** The app that was frontmost when the hotkey fired. */
  target: ActiveAppInfo | null
  abort: AbortController | null
  requestId: string | null
  answer: string
  /** Shapes currently painted on the display for this session. */
  annotations: Annotation[]
  /**
   * The conversation so far, oldest first: the user's questions and the answers
   * they got. It is what makes "а почему?" a follow-up instead of a brand new
   * question — without it the model only ever sees the last sentence and has no
   * idea what "это" refers to.
   *
   * Capped at `CARD_HISTORY_TURNS` exchanges and trimmed before storage, because a
   * session can stay open for a while and an unbounded history would quietly
   * grow every request until it hit the context limit.
   */
  history: CardExchange[]
  /**
   * Live preview while the overlay is open: the picture is re-taken on a timer
   * so both the thumbnail and the image sent with a request show the window as
   * it is now, not as it was at the moment the overlay opened.
   */
  live: { timer: NodeJS.Timeout | null; inFlight: boolean }
  /**
   * What went wrong during this turn but did not stop it.
   *
   * Its own list rather than a field on the snapshot: a context warning describes
   * the screen, and these describe the request. The card shows the first one, so
   * "the model rejected the screenshot, so this answer is text only" reaches the
   * person who asked rather than only the log.
   */
  notices: string[]
}

/**
 * Size the card is placed with before the renderer has laid itself out.
 *
 * Only placement uses it; the renderer reports the real size a frame later, so a
 * slightly generous guess here just keeps the first placement from flipping
 * sides afterwards.
 */
const INITIAL_HEIGHT = CARD_FOLDED_HEIGHT

/**
 * Shown when the provider refuses the screenshot.
 *
 * The turn continues without it, so this is a notice, not an error: the answer
 * arrives, and the only thing that changed is that the model could not see the
 * screen and therefore did not draw on it.
 */
const MODEL_REFUSED_IMAGE =
  'Модель не принимает изображения — ответ получен без скриншота и рисунка.'

/**
 * Shown when the card's app is on the exclusion list.
 *
 * The card normally never opens for such an app; this is the race where the
 * target changes while the card is already on screen.
 */
const EXCLUDED_APP = 'Приложение входит в список исключений — запрос не отправлен.'

/**
 * How long a spoken transcript stays on screen while its request is already
 * running. The old code waited this long before calling the model; now it is
 * only a floor for the card, not a pause in the work.
 */
const VOICE_PREVIEW_MS = 2_000

/** How often the open overlay re-captures the screen behind it. */
const LIVE_REFRESH_MS = 2000

/**
 * A shot younger than this still represents "this screen right now". A question
 * asked in the same instant as a live tick reuses it instead of paying for a
 * second capture.
 */
const MAX_SHOT_AGE_MS = 600

/**
 * The history of the current card.
 */
const CARD_HISTORY_TURNS = 2

/**
 * Ceiling for one side of a remembered exchange, question or answer. A long
 * answer is still referenced by its beginning — the part the follow-up is about —
 * and this keeps two turns of history from costing more than the question itself.
 */
const MAX_HISTORY_CHARS = 1_500

const STOP_AGENT = Symbol('stop-agent')
const TURN_DEADLINE_MS = 120_000

/** Time the compositor needs to start excluding the card from screen captures. */
const CONTENT_PROTECTION_SETTLE_MS = 45

/** The agent's exact reply for success without caveats. */
const AGENT_DONE_MARKER = '[[ACTION_DONE]]'

/** What OpenRouter wants on every request to attribute the traffic to this app. */
const OPENROUTER_ATTRIBUTION = {
  'HTTP-Referer': 'https://github.com/BobrAll/deskhand',
  'X-Title': 'Deskhand'
}

/**
 * How the trace names a finished agent run.
 *
 * The outcome and its reason come from the same flags, so they are decided
 * together: written as two separate chains they were easy to drift apart.
 */
function describeRunOutcome(run: AgentRunResult, acknowledged: boolean): { outcome: string; reason: string } {
  const spoke = run.answer.trim().length > 0
  const outcome = run.blocked ? 'blocked'
    : run.aborted ? 'cancelled'
      : run.incomplete ? 'incomplete'
        : spoke && !acknowledged ? 'agent-report' : 'agent-silent'
  const reason = run.blocked ? 'agent-unavailable'
    : run.aborted ? 'agent-stop'
      : run.incomplete ? 'agent-incomplete'
        : acknowledged ? 'agent-acknowledged'
          : spoke ? 'agent-answer' : 'no-answer'
  return { outcome, reason }
}

export function createOverlayController(host: OverlayHost) {
  let session: Session | null = null
  /** Whether the user is writing in the card right now (see `syncDrawing`). */
  let typing = false
  /**
   * Bumped by every `close()`. `open()` takes a long time (app, selection and
   * screenshot) and the user can finish speaking, and release the key, while it
   * is still collecting; without this the card would appear *after* the turn was
   * already closed — an empty panel left floating at the pointer with nothing
   * ever going to fill it.
   */
  let generation = 0

  /**
   * The `open()` currently collecting context, if any.
   *
   * A voice transcript can be ready before the card is: the window is shown
   * immediately on the key press, but the app and the selection still have to be
   * read. Delivering into that gap would put the phrase into the *previous*
   * session (or into no session at all), so `deliver` waits for this to settle.
   */
  let opening: Promise<void> | null = null
  /**
   * The spoken turn still in flight.
   *
   * A new press supersedes it immediately: while a voice answer is streaming or
   * an agent is clicking, the user pressing the key again means they are already
   * saying the next thing, and the old turn must not keep acting underneath them.
   */
  let voiceTurn: AbortController | null = null
  /**
   * The app a dictation hold is typing into.
   *
   * Kept apart from `session.target`: a dictation never opens a card, and a card
   * from an earlier question may remember a different app or none at all. Read
   * at press time, before any of our windows is on screen, because the
   * frontmost app after that may be us.
   */
  let dictationTarget: ActiveAppInfo | null = null
  /**
   * Which dictation hold is reading the screen right now.
   *
   * Reading the app is a helper round trip, and a short hold can end before it
   * answers. The bump in `endDictation` is what keeps that late answer from
   * becoming the target of the next hold.
   */
  let dictationRead = 0
  /**
   * Whether the assistant card owned the keyboard when the hold began.
   *
   * Such a hold ends by closing the card, which is also what hands focus back
   * to its app. An indicator-only hold just hides the bars and leaves the app
   * the user is typing in untouched.
   */
  let dictationOwnsCard = false
  /**
   * True while a dictation owns the screen.
   *
   * A card that was already collecting context when the hold began must not
   * finish by focusing itself, and its own `generation` check cannot see that:
   * the open is legitimate, it is only the moment that is wrong.
   */
  let dictating = false

  function setVoice(active: boolean): void {
    if (active) voiceTurn?.abort()
    host.setVoice(active)
  }

  /**
   * Remembers where a dictation hold has to paste, without opening the card.
   *
   * Opening the card means reading the selection with a synthetic ⌘C and then
   * focusing the window — both take the user out of the field they are still
   * typing in. Dictation therefore captures only the application that owns the
   * keyboard right now, which is enough for the paste and costs no context work.
   */
  async function beginDictation(): Promise<void> {
    dictating = true
    // A card still collecting context would focus itself in the middle of the
    // hold. Bumping the generation cancels that focus; `dictating` keeps its
    // cleanup from hiding the bars once they are up.
    if (opening) generation += 1
    const mine = ++dictationRead
    const front = await helperFrontApplication()
    // A newer hold, or the end of this one, owns the answer by now.
    if (mine !== dictationRead) return
    const win = host.window()
    const cardVisible = Boolean(session && win && !win.isDestroyed() && win.isVisible())
    const ours = front?.pid === process.pid
    dictationOwnsCard = ours && cardVisible
    if (ours) {
      // The card itself was in front: the app it belongs to is the one the user
      // came from. Without a visible card (settings is frontmost) there is no
      // field behind us worth typing into.
      dictationTarget = cardVisible ? session?.target ?? null : null
    } else {
      dictationTarget = front && front.pid > 0
        ? {
            bundleId: front.bundleId,
            name: front.name,
            pid: front.pid,
            windowTitle: front.windowTitle,
            windowId: front.windowId,
            bounds: front.bounds
          }
        : null
    }
    if (!dictationTarget) {
      host.showField(null)
      return
    }
    // The field itself, not just the app: the border has to sit on the control
    // the keyboard is in. The read is deliberately not awaited — the bars must
    // appear at once, and a slow Accessibility tree may only cost the border.
    void markDictationField(dictationTarget, mine)
  }

  /**
   * Finds the focused control and draws its border, if it can take text.
   *
   * A non-editable focused element (a button, a web view that does not expose
   * its editor) gets no border rather than a misleading rectangle around the
   * whole window. The token check drops a late answer from a hold that has
   * already ended.
   */
  async function markDictationField(target: ActiveAppInfo, mine: number): Promise<void> {
    const focused = await helperFocused(target.pid).catch(() => null)
    if (mine !== dictationRead) return
    // The system-wide answer can belong to the card itself when the card was in
    // front at press time while the target is the app behind it. That is our
    // own input, not the field the words will go into.
    const ownElement = focused?.pid === process.pid
    host.showField(!ownElement && focused?.editable && focused.frame ? focused.frame : null)
  }

  /**
   * Puts the screen back after a dictation hold.
   *
   * The remembered app is dropped here: the next hold starts wherever the user
   * is by then, and a stale target would paste one sentence into the window
   * before.
   */
  function endDictation(closeCard = false): void {
    const ownsCard = closeCard || dictationOwnsCard
    dictating = false
    dictationRead += 1
    dictationTarget = null
    dictationOwnsCard = false
    host.hideField()
    if (ownsCard) {
      // `close()` bumps the generation, so an in-flight `openInternal` cannot
      // focus an empty card after the key is already up. That is also what
      // returns focus to the app behind a primary-hotkey dictation turn.
      close()
      return
    }
    host.hide()
  }

  /**
   * The mouse-and-keyboard runner.
   *
   * It is created once per app, not per session: the abort watcher and the
   * "am I allowed to press" check belong to the process, and a plan that outlives
   * its session (the user closed the card mid-run) still has to be stopped by the
   * same object that started it.
   */
  const agent = createAgentController({
    setPassthrough: (active) => host.setPassthrough(active),
    emit: (event: AgentEvent) => publishAgent(event),
    present: (action) => paintAgentPresentation(action)
  })

  /** Keeps the card and the display layer in sync with the agent's state. */
  function publishAgent(event: AgentEvent): void {
    trace('agent.phase', { phase: event.phase, step: event.step, total: event.total, completed: event.completed === true, calls: event.actions?.length ?? 0 })
    sendToWindow(CH.agent.event, event)
    updateAgentCursor(event)
    // The ghost pointer follows the run, not the step: it is present from
    // `arming` to the terminal phase and waits between actions.
    updateAgentPresentation(event)
  }

  /**
   * Decides whether the card should stand aside for a drawing.
   *
   * Two things bring it back to full density: the shapes going away, and the user
   * starting to write. Typing is the interesting one — at that moment the card is
   * what they are reading, so a 40% panel would be the wrong thing to type into
   * even though the arrow is still on screen.
   */
  function syncDrawing(): void {
    host.setDrawing((session?.annotations.length ?? 0) > 0 && !typing)
  }

  function setTyping(value: boolean): void {
    if (typing === value) return
    typing = value
    syncDrawing()
  }

  function setupNotice(): OverlayState['setupNotice'] {
    const settings = getSettings()
    const label = providerInfo(settings.provider)?.label ?? settings.provider
    if (!resolveChatModel(settings)) {
      return {
        kind: 'warning',
        message: `Выбери модель ${label} в настройках.`
      }
    }
    if (!getApiKey(settings.provider)) {
      return {
        kind: 'warning',
        message: `Добавь ключ ${label} в настройках, чтобы получать ответы.`
      }
    }
    return null
  }

  function overlayState(): OverlayState | null {
    if (!session) return null
    const warnings = [...session.snapshot.warnings, ...session.notices]
    return {
      sessionId: session.id,
      context: session.snapshot,
      flags: session.flags,
      setupNotice: setupNotice(),
      warnings,
      agent: agent.availability()
    }
  }

  function sendToWindow(channel: string, payload: unknown): void {
    const win = host.window()
    if (!win || win.isDestroyed()) return
    win.webContents.send(channel, payload)
  }

  function publishState(): void {
    const next = overlayState()
    if (next) sendToWindow(CH.overlay.state, next)
  }

  /**
   * Persists the master switch and re-publishes the session state.
   *
   * The switch belongs to the settings window, but the user learns it is off at
   * the worst possible moment: they asked for an action and got an explanation.
   * Both windows go through here so they can never disagree — the settings tab
   * writes the same value through the same call, and a toggled checkbox that is
   * still sitting in an unsaved draft is exactly how the mode looks broken ("я же
   * включил, а он всё равно рисует").
   *
   * The answer is the availability *after* the write, so the caller can name what
   * still blocks the mode (almost always the Accessibility grant) instead of
   * treating the switch as the whole fix.
   */
  function setAgentEnabled(enabled: boolean): AgentAvailability {
    const agentSettings = getSettings().agent
    if (agentSettings.enabled !== enabled) {
      patchSettings({ agent: { ...agentSettings, enabled } })
    }
    if (!enabled) agent.stop()
    publishState()
    return agent.availability()
  }

  /** Emits the current context so the thumbnail reflects a freshly taken shot. */
  function publishContext(target: Session): void {
    if (session !== target) return
    sendToWindow(CH.overlay.contextUpdate, target.snapshot)
  }

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
  function captureFor(target: Session): Promise<ScreenshotInfo | null> {
    if (captureInFlight) {
      if (captureInFlight.sessionId === target.id) {
        trace('screen.captureJoined')
        return captureInFlight.promise
      }
      const next = (): Promise<ScreenshotInfo | null> | null => session === target ? captureFor(target) : null
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
  async function captureNow(target: Session): Promise<ScreenshotInfo | null> {
    const win = host.window()
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
        settings.agent.enabled || excludedApps.length > 0
          ? helperFrontWindow()
          : Promise.resolve(null),
        excludedApps.length > 0 ? helperVisibleBundleIds() : Promise.resolve(null)
      ])
      const underOverlay = front?.pid === process.pid
      // Under our own card the frontmost window is not the one being acted on:
      // read the remembered target's window instead.
      const observed = underOverlay
        ? (target.target ? await helperWindow(target.target.pid) : null)
        : front
      const capture = captureTargetFor({
        observed,
        remembered: target.target,
        excludedApps,
        visibleBundleIds
      })
      if (!capture) {
        target.snapshot.screenshot = null
        return null
      }
      const shot = await timed('screen.capture', () => captureScreenshot(
        capture,
        { maxSide: settings.screenshotMaxSide, quality: settings.screenshotQuality }
      ))
      if (shot && observed) {
        if (await windowStillMatches(observed)) {
          observedApps.set(shot, observed)
        }
        // The comparison above already recorded which field disagreed; this
        // line records only that the shot was dropped, without the window text.
        else trace('screen.observationRejected', { reason: 'window-changed-during-capture' })
      }
      if (session === target) {
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
   */
  async function ensureFreshScreenshot(target: Session, requireObserved = false): Promise<ScreenshotInfo | null> {
    const current = target.snapshot.screenshot
    if (current && Date.now() - current.capturedAt < MAX_SHOT_AGE_MS &&
        (!requireObserved || observedApps.has(current))) {
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
    const shot = await captureFor(target)
    if (session === target && (showPending || !shot)) {
      target.snapshot.screenshotPending = false
      publishContext(target)
    }
    return shot ?? (requireObserved ? null : target.snapshot.screenshot)
  }

  /** Re-captures on a timer while the card is on screen. */
  function startLive(target: Session): void {
    if (target.live.timer) return
    target.live.timer = setInterval(() => {
      if (session !== target) {
        stopLive(target)
        return
      }
      // The card is hidden (closed, or hidden for a paste): nothing to preview and
      // nothing that could be asked about, so idle instead of capturing the screen
      // every couple of seconds in the background.
      const win = host.window()
      if (!win || win.isDestroyed() || !win.isVisible()) {
        stopLive(target)
        return
      }
      // A capture during streaming would only compete with the answer for the
      // main thread; the send path already refreshed the image.
      if (target.live.inFlight || target.abort) return
      if (captureInFlight && captureInFlight.sessionId === target.id) return
      // Nothing to preview when the screenshot chip is off: a capture nobody asked
      // for would just spend battery. The drawing tool needs that image, so the
      // chip is the only switch that decides.
      if (!target.flags.includeScreenshot) return
      // While shapes are on screen a re-capture would swap the image the drawings
      // were measured against; their coordinates are already fixed to it.
      if (target.annotations.length > 0) return
      // Only re-capture when the previous frame is ageing out. A tick that lands
      // right after a request-time refresh would otherwise take a redundant shot.
      const current = target.snapshot.screenshot
      if (current && Date.now() - current.capturedAt < LIVE_REFRESH_MS / 2) return
      target.live.inFlight = true
      void captureFor(target).finally(() => {
        target.live.inFlight = false
      })
    }, LIVE_REFRESH_MS)
  }

  function stopLive(target: Session): void {
    if (target.live.timer) clearInterval(target.live.timer)
    target.live.timer = null
  }

  /**
   * Opens the card, sharing one collection between concurrent callers.
   *
   * The hotkey, push-to-talk and the tray all want the same card; running
   * `collectContext` twice at once would show the second session over the first.
   */
  function open(): Promise<void> {
    if (opening) {
      // A second press joining an open that is still collecting still gets the
      // card on screen immediately: the session can arrive later.
      host.showInactive(INITIAL_HEIGHT)
      return opening
    }
    const task = openInternal()
    opening = task
    const done = (): void => {
      if (opening === task) opening = null
    }
    void task.then(done, done)
    return task
  }

  /**
   * Brings an already open card up to date and gives it the keyboard.
   *
   * The picture is refreshed, and so is *the app the card is about*: while the
   * card sat on screen the user moved to another window, and the question they
   * are about to type is about that one. Keeping the app from the first open is
   * how a plan ends up clicking in the window the user left — `agent.execute`
   * brings the target to the front before the first step, so a stale target does
   * not just mislabel the answer, it physically raises the wrong window over the
   * one on screen.
   *
   * The context has to be read before the focus is taken: our own card is what
   * the frontmost app becomes a moment later.
   */
  async function refreshOpenCard(startedIn: number, win: BrowserWindow): Promise<void> {
    const front = await helperFrontApplication()
    const elsewhere = front && front.pid > 0 && front.pid !== process.pid
    if (elsewhere) {
      const settings = getSettings()
      const { snapshot, flags } = await collectContext({
        excludedApps: settings.excludedApps,
        wantsScreenshot: settings.captureScreenshotByDefault
      })
      if (startedIn === generation && session && snapshot.excluded) {
        session.target = null
        close()
        return
      }
      if (startedIn === generation && session) {
        session.snapshot = snapshot
        session.target = snapshot.activeApp
        session.flags = flags
        // The drawing belonged to the previous screen.
        discardAnnotations()
      }
    } else if (session && session.snapshot.activeApp) {
      void ensureFreshScreenshot(session)
    }
    if (startedIn !== generation || dictating || !session) return
    win.focus()
    startLive(session)
  }

  /**
   * Opens the card, then collects the context into it.
   *
   * The order is the whole point. Collecting means reading the frontmost app and,
   * when something is selected, synthesizing ⌘C and polling the pasteboard for up
   * to 450 ms — and with nothing selected that is *always* 450 ms of nothing. The
   * card used to appear only after that, so a press was followed by half a second
   * in which the app looked like it had not noticed the key: people pressed again,
   * and the second press found a card that was just about to appear. The window
   * therefore comes up first, empty and unfocused, and the context lands in it a
   * moment later.
   *
   * Unfocused is not a detail. `collectContext` asks macOS which application is
   * frontmost, and a focused overlay would answer "Deskhand": the remembered
   * target, the selected text and the paste destination would all become our own
   * window. So the card is shown with `showInactive`, the context is read from the
   * app behind it, and only then does the window take the keyboard.
   */
  async function openInternal(): Promise<void> {
    const startedIn = generation
    const win = host.window()
    if (session && win?.isVisible()) {
      await refreshOpenCard(startedIn, win)
      return
    }

    // The card is on screen before the context exists — see the note above. The
    // renderer draws the folded card itself in that state — same field, same
    // placeholder — so what the user sees at once is the card, not a delay and not
    // a status line announcing one.
    //
    // The previous session is dropped *first*: it is a closed card's leftovers, and
    // leaving it in place would let `getState` hand the renderer the last answer
    // while this one is still being collected — which reads as an answer to a
    // question that has not been asked yet. A voice turn can still be running
    // while its card is hidden, so stop it before replacing its session.
    if (session?.abort) {
      session.abort.abort()
      agent.stop()
    }
    if (session) stopLive(session)
    session = null
    host.showInactive(INITIAL_HEIGHT)
    // The renderer is the same page as last time and still shows the last answer:
    // it has to be told to drop it, or a reopened card would appear to answer the
    // question before it was asked.
    sendToWindow(CH.overlay.preparing, null)

    const settings = getSettings()
    const { snapshot, flags } = await collectContext({
      excludedApps: settings.excludedApps,
      wantsScreenshot: settings.captureScreenshotByDefault,
      onCopySent: () => {
        if (!dictating && startedIn === generation) host.show(INITIAL_HEIGHT)
      }
    })

    // The turn ended while the context was being collected, or a dictation took
    // the screen: showing the card now would leave an empty panel on screen with
    // no way to dismiss it, or take the keyboard from the user's own field. A
    // dictation is the one case that hides nothing — the same window is already
    // showing its bars.
    if (startedIn !== generation || dictating) {
      if (!dictating) host.hide()
      return
    }

    if (snapshot.excluded) {
      console.log('[overlay] active app is on the exclusion list — nothing collected')
      host.hide()
      return
    }

    // A new session starts with a clean screen even if the previous one left a
    // drawing visible for a moment before it was closed.
    hideAnnotations()
    // …and with a solid card: a dimmed window would otherwise carry over from
    // the previous session and the new answer would open see-through.
    typing = false
    host.setDrawing(false)

    const id = randomUUID()
    session = {
      id,
      snapshot,
      flags,
      target: snapshot.activeApp,
      abort: null,
      requestId: null,
      answer: '',
      annotations: [],
      history: [],
      live: { timer: null, inFlight: false },
      notices: []
    }

    // Focus is taken only now, once the context is safely collected: the card was
    // on screen (inactive) from the first millisecond, but the keyboard goes to it
    // here, so a keystroke typed at once lands in the field and not in the user's
    // document.
    host.show(INITIAL_HEIGHT)
    sendToWindow(CH.overlay.state, overlayState())

    // The card is on screen now, so the first capture happens while it is: the
    // live path keeps our own window out of the picture. The image is taken even
    // when the chip is off for this session (a selection exists), so the user can
    // still switch the screenshot on and get a current frame.
    const target = session
    if (settings.captureScreenshotByDefault && snapshot.activeApp) {
      void ensureFreshScreenshot(target).then(() => {
        if (session !== target) return
        const next = overlayState()
        if (next) sendToWindow(CH.overlay.state, next)
        startLive(target)
      })
    }
  }

  function close(): void {
    generation += 1
    // Remembered before the session is torn down: this is the app the keyboard
    // has to go back to (see `returnFocusTo`). The flag matters because `close()`
    // is also called for a card that was never open (a voice turn that ends in
    // dictation mode), and stealing focus then would be the opposite of help.
    const target = session?.target ?? null
    const wasOpen = Boolean(session && host.window()?.isVisible())
    // A plan outlives the card if it is not stopped here: closing the overlay
    // while the assistant is mid-click must return the machine to the user.
    agent.stop()
    if (session) {
      stopLive(session)
      session.abort?.abort()
      session.abort = null
      session.annotations = []
    }
    // The drawings belong to the answer: closing the card must not leave an
    // unexplained arrow floating on the user's screen.
    hideAnnotations()
    // Without this the window would stay unblurred for the rest of the session:
    // the next answer would open as a see-through sheet of glass.
    typing = false
    host.setDrawing(false)
    host.hide()
    if (!wasOpen) return
    // The card took the keyboard when it opened (that is how the field is typed
    // into), and hiding the window does not give it back: macOS leaves the key
    // with an application that no longer has a window, so the user types into
    // nothing. Escape means "done, back to my work", not "the assistant is in the
    // way" — so focus is handed back explicitly.
    void returnFocusTo(target)
  }

  /**
   * Gives the keyboard back to the app the user was working in.
   *
   * Two cases, and both used to leave the machine in a state where typing went
   * nowhere:
   *
   * - the remembered target still exists — it is activated, which is exactly what
   *   "return me where I was" means;
   * - there is no target (the app was on the exclusion list, or the frontmost app
   *   could not be read) — then hiding ourselves is the only honest move: macOS
   *   hands the keyboard to the next application instead of to a windowless app.
   *   `app.hide()` is skipped while another of our windows is visible, because it
   *   hides those too — and a settings window the user opened on purpose is not
   *   something to close on their behalf.
   */
  async function returnFocusTo(target: ActiveAppInfo | null): Promise<void> {
    if (target && (target.bundleId || target.pid > 0)) {
      try {
        if (await helperActivate({ bundleId: target.bundleId, pid: target.pid })) return
      } catch {
        /* fall through to hiding ourselves */
      }
    }
    const overlay = host.window()
    const others = BrowserWindow.getAllWindows().some(
      (win) => win !== overlay && !win.isDestroyed() && win.isVisible()
    )
    if (others) return
    app.hide()
  }

  /** Reports the current drawing state so the card can offer a "убрать" action. */
  function emitAnnotations(): void {
    const count = session?.annotations.length ?? 0
    // The card's own density and the window's blur both follow this number;
    // routing them through here keeps the two from ever disagreeing.
    syncDrawing()
    sendToWindow(CH.overlay.annotations, { count })
  }

  /**
   * Takes the shapes off the screen and out of the session.
   *
   * The two always move together: a shape the display still paints after the
   * session forgot it would outlive the answer it was drawn for.
   */
  function discardAnnotations(): void {
    if (session) session.annotations = []
    hideAnnotations()
    emitAnnotations()
  }

  /** Removes the drawings but keeps the card and the answer. */
  function clearAnnotations(): void {
    if (!session) return
    discardAnnotations()
  }

  function setFlags(flags: ContextFlags): void {
    if (!session) return
    const previous = session.flags
    session.flags = {
      includeSelection: Boolean(flags.includeSelection),
      includeScreenshot: Boolean(flags.includeScreenshot)
    }
    publishState()
    // Switching the screenshot on must not resurrect a stale image — and must
    // start the live refresh if it was not running (selection present on open).
    if (session.flags.includeScreenshot) {
      const target = session
      if (!previous.includeScreenshot || !target.snapshot.screenshot) {
        void ensureFreshScreenshot(target)
      }
      startLive(target)
    } else {
      // No image means no drawing tool: the model cannot point at a screen it was
      // never shown, and a stale arrow must not outlive the image behind it.
      stopLive(session)
      discardAnnotations()
    }
  }

  function resize(height: number, width?: number, pin?: boolean): void {
    host.resize(height, width, pin)
  }

  /**
   * One request, streamed into the card.
   *
   * This is the writer's half of the app: a question goes to the model, the
   * answer streams in, and any shapes it asked for are painted as they arrive.
   * The agent does not go through here — it owns its own loop and its own
   * captures — so there is exactly one caller shape to keep working, and the
   * drawing tool is the only thing the parser has to survive.
   */
  async function streamRound(options: {
    messages: ChatMessage[]
    requestId: string
    maxTokens: number
    signal: AbortSignal
    canDraw: boolean
    area: ScreenRect | null
    apiKey: string
    /** Reveal a spoken answer as soon as its first text arrives. */
    revealText?: boolean
    drawingTargets?: AxElementInfo[]
  }): Promise<{ text: string; webLookup?: boolean }> {
    const { messages, requestId, maxTokens, signal, canDraw, area, apiKey } = options
    const settings = getSettings()

    /**
     * Paints newly parsed shapes. Called as the stream arrives so the explanation
     * and the drawing grow together instead of the arrow appearing only after the
     * last token.
     *
     * Serialised through `painting`: two overlapping window updates would race,
     * and the loser could erase a shape the winner had already shown.
     */
    let dismissed = false
    let painting: Promise<void> = Promise.resolve()
    const paint = (shapes: Annotation[]): void => {
      if (dismissed || shapes.length === 0 || !canDraw || !area || !session) return
      shapes = shapes.map((shape) => groundAnnotation(shape, options.drawingTargets ?? [], area))
      const next = [...session.annotations, ...shapes]
      session.annotations = next
      emitAnnotations()
      painting = painting.then(() => {
        if (dismissed) return
        return showAnnotations(area, next, () => {
          dismissed = true
          clearAnnotations()
        })
      }).catch(() => undefined)
    }

    const append = (delta: string): void => {
      if (!delta || !session) return
      const hadAnswer = session.answer.trim().length > 0
      session.answer += delta
      const event: StreamEvent = { type: 'chunk', requestId, delta }
      sendToWindow(CH.overlay.stream, event)
      if (options.revealText && !hadAnswer && session.answer.trim()) {
        host.showInactive(INITIAL_HEIGHT)
      }
    }

    // Everything that is not about this window — parsing, filtering, the tail —
    // lives in `consumeTurnStream`, so it can be driven by a fake provider.
    const result = await timed('model.round', () => consumeTurnStream({
      provider: getProvider(settings.provider),
      messages,
      apiKey,
      streamOptions: {
        model: resolveChatModel(settings) ?? '',
        temperature: settings.temperature,
        maxTokens,
        baseUrl: resolveBaseUrl(settings.provider, settings.baseUrls[settings.provider]),
        extraBody: parseExtraBody(settings.extraBody[settings.provider]) ?? undefined,
        signal
      },
      isAlive: () => !signal.aborted && Boolean(session),
      onAnnotations: paint,
      onText: append
    }), { provider: settings.provider, model: resolveChatModel(settings) ?? '', withImage: Boolean(area),
      imageBase64Bytes: messages.reduce((size, message) => size + message.parts.reduce(
        (total, part) => total + (part.type === 'image' ? part.base64.length : 0), 0), 0) })
    return result
  }

  function send(request: SendRequest): Promise<void> {
    if (!session || request.refine) return sendTurn(request)
    const settings = getSettings()
    // A short digest of everything that changes what a run does, so the trace can
    // group runs by configuration without recording any of the values — a model
    // name and a temperature are the user's business, not the log's.
    const config = createHash('sha256').update(JSON.stringify([
      settings.provider, resolveChatModel(settings), settings.temperature, settings.maxTokens,
      settings.agent.enabled, settings.agent.maxSteps, settings.agent.verifyResult,
      settings.agent.abortOnMouseMove,
      settings.screenshotMaxSide, settings.screenshotQuality
    ])).digest('hex').slice(0, 12)
    return traceTurn({ voice: request.voice === true, provider: settings.provider, config }, () => sendTurn(request))
  }

  async function sendTurn(request: SendRequest): Promise<void> {
    if (!session) return
    const settings = getSettings()

    const fail = (message: string, retryable: boolean, code?: StreamEventCode): void => {
      const event: StreamEvent = { type: 'error', requestId: request.requestId, message, retryable, code }
      sendToWindow(CH.overlay.stream, event)
      if (request.voice) host.showInactive(INITIAL_HEIGHT)
    }

    // The card normally closes before a turn can start in an excluded app, but
    // the target can change while it is already on screen. The error is what
    // clears the busy state; a bare return left the card waiting forever.
    if (isExcluded(session.target, settings.excludedApps)) {
      trace('turn.outcome', { outcome: 'blocked', reason: 'excluded-app' })
      fail(EXCLUDED_APP, false)
      return
    }
    const model = resolveChatModel(settings)
    const apiKey = getApiKey(settings.provider)

    if (!model) {
      fail('Модель не выбрана. Открой настройки и укажи модель.', false)
      return
    }
    if (!apiKey) {
      trace('turn.outcome', { outcome: 'blocked', reason: 'missing-key' })
      fail('Не задан ключ API. Открой настройки и добавь ключ.', false)
      return
    }

    // "Короче / длиннее": the previous answer is the whole input, so no context,
    // no screenshot and no selection are re-sent.
    const refine = request.refine ?? null
    const baseAnswer = refine ? refine.baseAnswer.trim() : ''
    if (refine && !baseAnswer) {
      fail('Пока нечего переписывать — сначала получи ответ.', false)
      return
    }

    session.abort?.abort()
    // A new question is a new turn: a plan from the previous answer must not be
    // able to keep clicking into this one.
    agent.stop()

    const abort = new AbortController()
    session.abort = abort
    // A spoken turn belongs to the microphone from the moment it is sent: the
    // next press must be able to stop it without waiting for the answer.
    if (request.voice) voiceTurn = abort
    session.requestId = request.requestId
    session.answer = ''
    const availability = agent.availability()
    /**
     * Whether this turn is for the agent rather than for the writer.
     *
     * This is the one routing decision in the turn, and it is made before any
     * model is called: an action request must not pay for a text round first,
     * because that round's only job would be to guess what the agent is about
     * to do anyway.
     *
     * The rule is the verb, not the mode. `looksLikeAction` is the same gate that
     * already decides whether the pointer glow promises an action, so the card and
     * the routing cannot disagree: if the glow said "готовлю действия", the agent
     * runs. When the agent cannot run — mode off, no Accessibility — the turn
     * falls through to the writer with `actReason` set, which is what produces the
     * honest "я не могу нажать, вот почему" answer instead of a silent arrow.
     */
    const isActionRequest = !refine && availability.ready && looksLikeAction(request.prompt)
    // Claim before screenshot/AX/model work, including cancellation mid-turn.
    const glowTurn = beginAgentTurn(isActionRequest)
    const turnSession = session
    let outcome = 'abandoned'
    let reason = 'session-changed'
    let deadline: ReturnType<typeof setTimeout> | undefined
    /**
     * Hides the card after a spoken transcript has had its reading time, if the
     * answer has not arrived by then. It is a timer, not an `await`, precisely so
     * the model round trip starts now.
     */
    let previewHide: ReturnType<typeof setTimeout> | undefined
    const previewUntil = request.voice && host.window()?.isVisible()
      ? Date.now() + VOICE_PREVIEW_MS
      : 0
    try {
      // A spoken request is routed immediately. The transcript stays in the
      // composer while the turn is busy (the renderer keeps it until the first
      // answer chunk), so reading it and starting the work happen in parallel
      // instead of the card sitting still for two seconds first.
      deadline = setTimeout(() => abort.abort('deadline'), TURN_DEADLINE_MS)
      const bundleId = turnSession.target?.bundleId || null
      // The exclusion list was already checked before the turn was registered,
      // and nothing has been awaited since: the same `settings` still describe
      // this turn.
      const useHistory = settings.rememberConversation
      const history = turnSession.history.filter(
        (entry) => !entry.bundleId || !settings.excludedApps.includes(entry.bundleId)
      )
      const previousCommand = useHistory && !refine && turnSession.history.length === 0
        ? readPreviousCommand(settings.excludedApps)
        : undefined

      if (request.voice && !isActionRequest) {
        // The request is already under way. Give the reader the transcript for
        // its two seconds and only then get the card out of the way; if the
        // answer arrives sooner, the `finally` clears this timer and the answer
        // takes the card instead of being hidden by it.
        const wait = previewUntil - Date.now()
        if (wait > 0) {
          previewHide = setTimeout(() => {
            previewHide = undefined
            if (session === turnSession && !abort.signal.aborted) host.hide()
          }, wait)
        } else {
          host.hide()
        }
      }

      // The drawings belong to the answer currently on screen: a new question
      // replaces that answer, so old arrows must not stay behind as if they
      // explained the new one. A rewrite ("короче") keeps them — it is the same
      // answer in other words.
      if (!refine) discardAnnotations()

      const turn: TurnContext = {
        request,
        session: turnSession,
        settings,
        apiKey,
        refine,
        history,
        previousCommand,
        useHistory,
        availability,
        abort
      }
      const result = isActionRequest ? await runAgentTurn(turn) : await runWriterTurn(turn)
      if (!result) return

      // The turn's own session, not the module-level one: the runner returned
      // only because both still point at the same card.
      turnSession.answer = result.answer
      outcome = result.outcome
      reason = result.reason

      const entry = remember(turnSession, request, result.acknowledged ? 'Готово.' : result.answer, bundleId)
      const latestSettings = getSettings()
      if (entry && !refine && useHistory && latestSettings.rememberConversation) {
        saveCommand(entry.question, bundleId, latestSettings.excludedApps)
      }

      const done: StreamEvent = {
        type: 'done',
        requestId: request.requestId,
        text: result.answer,
        annotations: turnSession.annotations.length
      }
      sendToWindow(CH.overlay.stream, done)
      if (result.acknowledged || result.answer.trim()) {
        // A voice turn, an agent turn and a card that was hidden while it waited
        // all end with the answer arriving rather than streaming: the card has to
        // be brought back to show it.
        if (request.voice || isActionRequest || !host.window()?.isVisible()) {
          host.showInactive(INITIAL_HEIGHT)
        }
      } else if (request.voice) {
        // Nothing to show and nothing to read: keep the card only when the answer
        // would have been spoken, because then the user needs the text of it.
        if (getSettings().voice.answerVoice !== 'off') host.showInactive(INITIAL_HEIGHT)
        else host.hide()
      }
    } catch (error) {
      outcome = 'error'
      reason = error instanceof ProviderError ? 'provider' : 'internal'
      trace('turn.error', { providerError: error instanceof ProviderError, aborted: abort.signal.aborted })
      if (abort.signal.aborted) return
      if (error instanceof ProviderError) {
        fail(error.message, error.retryable)
        return
      }
      fail(error instanceof Error ? error.message : 'Неизвестная ошибка запроса.', true)
    } finally {
      clearTimeout(deadline)
      if (previewHide) {
        clearTimeout(previewHide)
        previewHide = undefined
      }
      if (abort.signal.aborted) {
        outcome = abort.signal.reason === 'deadline' ? 'timeout' : 'cancelled'
        reason = outcome === 'timeout' ? 'deadline' : abort.signal.reason === STOP_AGENT ? 'agent-stop' : 'turn-abort'
        if (session === turnSession && turnSession.abort === abort) {
          if (outcome === 'timeout') fail('Время выполнения истекло. Результат не подтверждён.', true, 'timeout')
          else if (abort.signal.reason === STOP_AGENT) {
            if (agent.last().phase !== 'aborted') publishAgent({
              phase: 'aborted', step: 0, total: 0, label: '', message: 'Остановлено.'
            })
            sendToWindow(CH.overlay.stream, { type: 'done', requestId: request.requestId, text: '', annotations: 0 } satisfies StreamEvent)
          }
        }
      }
      trace('turn.outcome', { outcome, reason })
      trace('turn.finished', { aborted: abort.signal.aborted })
      if (turnSession.abort === abort) turnSession.abort = null
      if (voiceTurn === abort) voiceTurn = null
      endAgentTurn(glowTurn)
    }
  }

  /**
   * Stops the agent when the turn that started it is aborted.
   *
   * The card's Stop button, the turn deadline, a new voice press and a closed
   * card all abort the turn's controller, while the run itself only knows about
   * Escape and the mouse. Without this the agent keeps clicking after the card
   * said the turn was over. The listener lives exactly as long as the run it
   * guards, so aborting a writer turn cannot reach a run that is not its own.
   *
   * Returns the cleanup; a listener left on an old signal would stop a later
   * turn's run.
   */
  function stopAgentOnAbort(abort: AbortController): () => void {
    const stop = (): void => agent.stop()
    abort.signal.addEventListener('abort', stop, { once: true })
    return () => abort.signal.removeEventListener('abort', stop)
  }

  /**
   * The agent's half of a turn: hand the request to the plan runner and translate
   * what it did into the text the card shows and the verdict the trace records.
   *
   * Returns `null` when the card or the abort moved on while the run was in
   * flight: there is nothing left to show, and the caller's `finally` cleans up.
   */
  async function runAgentTurn(turn: TurnContext): Promise<TurnResult | null> {
    const { request, session: turnSession, settings, apiKey, history, previousCommand, useHistory, abort } = turn
    trace('tool.route', { backend: 'agent', reason: 'action-request' })
    if (abort.signal.aborted) return null
    if (!host.window()?.isVisible()) host.showInactive(INITIAL_HEIGHT)
    // The card shows the screen the agent is about to work on. The agent
    // takes its own captures — this one is for the person watching, and it
    // is not sent to any model.
    void ensureFreshScreenshot(turnSession).catch(() => null)

    // The agent is given the same conversation the writer would get. «Сделай»
    // is not a task on its own: it means "the thing that was just discussed",
    // and that sentence lives in the turns above it.
    const agentHistory = useHistory
      ? history.map(({ question, answer }) => ({ question, answer }))
      : []
    if (agentHistory.length === 0 && previousCommand) {
      agentHistory.push({ question: previousCommand, answer: '' })
    }

    const stopOnAbort = stopAgentOnAbort(abort)
    let run: AgentRunResult
    try {
      run = await timed('agent.run', () => agent.run({
        prompt: request.prompt,
        appName: turnSession.target?.name ?? null,
        windowTitle: turnSession.target?.windowTitle ?? null,
        history: agentHistory,
        provider: agentProvider(settings, apiKey),
        excludedApps: settings.excludedApps
      }))
    } finally {
      stopOnAbort()
    }
    if (abort.signal.aborted || session !== turnSession) return null

    // What the loop had to work around — a refused screenshot is the case that
    // exists today. Read from the run rather than from the agent event stream so
    // the card learns it once, at the moment the answer lands.
    const notice = agent.last()?.notice
    if (notice && !turnSession.notices.includes(notice)) {
      turnSession.notices = [...turnSession.notices, notice]
      publishState()
    }

    const report = run.answer.trim()
    const acknowledged = report === AGENT_DONE_MARKER && !run.message &&
      !run.blocked && !run.aborted && !run.incomplete
    const answer = acknowledged ? '' : run.incomplete
      ? (run.message ?? '')
      : report || (run.message ?? '')
    const { outcome, reason } = describeRunOutcome(run, acknowledged)
    const nothingToShow = !acknowledged && run.actions.length === 0 && !run.blocked && !run.incomplete
    return {
      answer: nothingToShow ? emptyAnswerFallback(answer, 0) || answer : answer,
      outcome,
      reason,
      acknowledged
    }
  }

  /**
   * The writer's half of a turn: build the request, stream it, and — when the
   * model asked for it — replace the answer with a web search.
   *
   * Returns `null` when the turn was abandoned: the card closed while the request
   * was being built, or the abort fired between the awaits.
   */
  async function runWriterTurn(turn: TurnContext): Promise<TurnResult | null> {
    const {
      request, session: turnSession, settings, apiKey, refine, history, previousCommand,
      availability, abort
    } = turn
    let observedApp: RawFrontApp | undefined
    let drawingTargets: AxElementInfo[] = []

    /**
     * Whether the picture the outline is measured against still shows the same
     * window. Drops the observation when it does not, so nothing downstream can
     * name a window that is no longer in front.
     */
    const observationHolds = async (): Promise<boolean> => {
      if (!observedApp) return true
      if (await windowStillMatches(observedApp)) return true
      observedApp = undefined
      return false
    }

    /**
     * One model round for a request built here.
     *
     * The two rounds of a turn differ only in their frame: the retry after a
     * refused image has neither a picture nor the names measured against one.
     * Everything that identifies the turn — its id, its abort signal, whether the
     * text is spoken — stays the same, so it is passed once.
     */
    const streamBuilt = (
      turnRequest: TurnRequest,
      frame: { canDraw: boolean; area: ScreenRect | null; drawingTargets: AxElementInfo[] }
    ): Promise<{ text: string; webLookup?: boolean }> => streamRound({
      messages: turnRequest.messages,
      requestId: request.requestId,
      maxTokens: turnRequest.maxTokens,
      signal: abort.signal,
      canDraw: frame.canDraw,
      area: frame.area,
      apiKey,
      drawingTargets: frame.drawingTargets,
      revealText: request.voice
    })

    const built = await buildTurnRequest({
      request,
      session: turnSession,
      history,
      previousCommand,
      settings,
      availability,
      ensureFreshScreenshot: async () => {
        const shot = await ensureFreshScreenshot(turnSession, settings.agent.enabled)
        observedApp = shot ? observedApps.get(shot) : undefined
        return shot
      },
      describeScreen: async (pid, bounds, area) => {
        if (!(await observationHolds())) return null
        const outline = await readScreenOutline(observedApp?.pid ?? pid, observedApp?.bounds ?? bounds, area, (targets) => {
          drawingTargets = targets
        })
        if (!(await observationHolds())) {
          drawingTargets = []
          return null
        }
        return observedApp
          ? [`Активное приложение на свежем снимке: ${observedApp.name}`, outline].filter(Boolean).join('\n')
          : outline
      },
      aborted: () => abort.signal.aborted || session !== turnSession
    })
    if (built.abandoned || abort.signal.aborted || session !== turnSession) return null

    let round: { text: string; webLookup?: boolean }
    try {
      round = await streamBuilt(built, {
        canDraw: built.canDraw,
        area: built.area,
        drawingTargets
      })
    } catch (error) {
      // The provider refused the picture. Whether a model takes images is not
      // knowable before the call — the user names it — so the refusal itself is
      // the answer, and it is not worth ending the turn over: the same question
      // is asked again without the screenshot, and the card says why the answer
      // has no drawing.
      if (!(error instanceof ProviderError) || !error.imageRejected || !built.useImage) throw error
      if (abort.signal.aborted || session !== turnSession) return null
      turnSession.notices = [...turnSession.notices, MODEL_REFUSED_IMAGE]
      publishState()
      trace('turn.imageRejected', { retried: true })
      const retried = await buildTurnRequest({
        request,
        session: turnSession,
        history,
        previousCommand,
        settings,
        availability,
        omitImage: true,
        ensureFreshScreenshot: async () => null,
        describeScreen: async () => null,
        aborted: () => abort.signal.aborted || session !== turnSession
      })
      if (retried.abandoned || abort.signal.aborted || session !== turnSession) return null
      drawingTargets = []
      round = await streamBuilt(retried, { canDraw: false, area: null, drawingTargets })
    }
    if (abort.signal.aborted || session !== turnSession) return null

    const webLookup = !refine && round.webLookup && allowsWebLookup(request.prompt)
    trace('tool.route', { backend: webLookup ? 'web-search' : 'text',
      reason: webLookup ? 'search-marker' : 'plain-response' })
    const webAnswer = webLookup
      ? await timed('web.search', () => searchWeb(request.prompt, settings, apiKey, abort.signal))
      : ''
    if (abort.signal.aborted || session !== turnSession) return null

    // The round's prose is taken from the round, not from what the stream
    // happened to append: the parser is the authority on what the answer is,
    // and a delta dropped because the card closed mid-stream must not leave a
    // half-sentence behind as if it were the whole answer.
    const answer = webLookup ? webAnswer : round.text
    return {
      answer: emptyAnswerFallback(answer, turnSession.annotations.length) || answer,
      outcome: 'answer',
      reason: webLookup ? 'search-response' : 'plain-response',
      acknowledged: false
    }
  }

  /**
   * The provider configuration, in the shape the agent's process expects.
   *
   * The key is handed over per run and never written anywhere the agent could
   * keep it: the agent is a child process of this app, and the app already owns
   * the keychain entry. Duplicating it into the agent's own config file would be
   * a second copy of a secret, with a second lifetime to get wrong.
   */
  function agentProvider(settings: ReturnType<typeof getSettings>, apiKey: string): AgentProvider {
    return {
      wire: settings.provider === 'anthropic' ? 'anthropic' : 'openai',
      baseUrl: resolveBaseUrl(settings.provider, settings.baseUrls[settings.provider]),
      model: resolveChatModel(settings) ?? '',
      apiKey,
      maxTokens: settings.maxTokens,
      temperature: settings.temperature,
      extraBody: parseExtraBody(settings.extraBody[settings.provider]) ?? undefined,
      // OpenRouter asks for attribution headers on every request, and the agent
      // builds its own HTTP client — it has no idea which gateway this is. The
      // writer's provider carries them; the agent's has to be told.
      headers: settings.provider === 'openrouter' ? OPENROUTER_ATTRIBUTION : undefined
    }
  }

  function cancel(requestId: string): void {
    if (session?.requestId === requestId) session.abort?.abort()
  }

  /**
   * Appends a finished turn to the conversation.
   *
   * A rewrite replaces the answer it reworked instead of adding a turn: "короче"
   * is the same answer in other words, and remembering both would have the model
   * follow up on a text that is no longer on screen.
   */
  function remember(turnSession: Session, request: SendRequest, answer: string, bundleId: string | null): CardExchange | null {
    const question = request.prompt.trim()
    const reply = answer.trim()
    if (!question || !reply) return null

    const entry: CardExchange = {
      bundleId,
      question: question.length > MAX_HISTORY_CHARS
        ? `${question.slice(0, MAX_HISTORY_CHARS)}…`
        : question,
      answer:
        reply.length > MAX_HISTORY_CHARS
          ? `${reply.slice(0, MAX_HISTORY_CHARS)}…`
          : reply
    }
    const last = turnSession.history[turnSession.history.length - 1]
    if (request.refine && last?.question === entry.question) {
      turnSession.history[turnSession.history.length - 1] = entry
    } else {
      turnSession.history.push(entry)
    }
    // Oldest first out: the last `CARD_HISTORY_TURNS` exchanges are what a follow-up
    // can refer to, and everything older only costs tokens.
    if (turnSession.history.length > CARD_HISTORY_TURNS) {
      turnSession.history.splice(0, turnSession.history.length - CARD_HISTORY_TURNS)
    }
    return entry
  }

  async function copy(text: string): Promise<{ ok: boolean }> {
    await copyText(text)
    return { ok: true }
  }

  async function paste(text: string): Promise<PasteResult> {
    const target = session?.target ?? null
    // The drawing pointed at something the user has now acted on: leaving it up
    // would cover the very text we are pasting.
    discardAnnotations()
    host.hide()
    return pasteAnswer(text, target)
  }

  /**
   * Puts recognised speech into the card.
   *
   * When the card is closed the text still has to go somewhere, so it opens as
   * usual and the renderer receives the transcript through `CH.voice.transcript`
   * once its state is ready — that wiring lives in the voice controller's host.
   * If the open is still collecting context, the transcript waits for it: the
   * renderer would otherwise ask the *previous* session (or no session at all).
   */
  function deliver(text: string, { submit }: { submit: boolean }): void {
    const push = (): void => sendToWindow(CH.voice.transcript, { text, send: submit })
    if (opening) {
      void opening.then(push, push)
      return
    }
    push()
  }

  return {
    open,
    close,
    state: overlayState,
    setFlags,
    clearDrawing: clearAnnotations,
    setTyping,
    setVoice,
    beginDictation,
    endDictation,
    showVoiceIndicator: () => host.showInactive(INITIAL_HEIGHT),
    resize,
    send,
    cancel,
    copy,
    paste,
    deliver,
    emit: sendToWindow,
    agentAvailability: () => agent.availability(),
    setAgentEnabled,
    /** Answers the question the card is showing, if it is still the same one. */
    answerAgent: (id: string, allow: boolean, remember: boolean) => agent.answer(id, allow, remember),
    /** Ends the agent process; called on quit so none outlives the window. */
    disposeAgent: () => agent.dispose(),
    stopAgent: () => {
      // Both halves are stopped, always: the writer's stream and the agent's run
      // are exclusive per turn, so a stop that only reached one of them would
      // look like a stop that did nothing.
      agent.stop()
      if (session?.abort) session.abort.abort(STOP_AGENT)
    },
    // While a dictation is reading the front app, the old card target is not a
    // fallback: a partial window that arrives in that gap must wait rather than
    // paste into the app a previous card happened to belong to.
    target: (): ActiveAppInfo | null =>
      dictating ? dictationTarget : session?.target ?? null,
    isOpen: (): boolean => Boolean(session && host.window()?.isVisible())
  }
}

export type OverlayController = ReturnType<typeof createOverlayController>
