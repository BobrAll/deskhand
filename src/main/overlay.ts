/**
 * The overlay session: everything between "hotkey pressed" and "overlay hidden".
 *
 * Flow (ТЗ §4): remember the frontmost app -> collect context -> show the
 * overlay next to the cursor -> stream the answer -> paste / copy / retry / close.
 */

import { randomUUID } from 'node:crypto'
import { app, BrowserWindow } from 'electron'
import { CH } from '@shared/ipc'
import { modelSupportsVision, providerInfo, resolveBaseUrl } from '@shared/defaults'
import type {
  ActiveAppInfo,
  AgentAvailability,
  AgentEvent,
  Annotation,
  ContextFlags,
  ContextSnapshot,
  AgentPlanStep,
  OverlayState,
  PasteResult,
  ScreenshotInfo,
  ScreenRect,
  SendRequest,
  StreamEvent
} from '@shared/types'
import { createAgentController } from './agent'
import { beginAgentTurn, endAgentTurn, updateAgentCursor } from './agent/cursor'
import { normalizePlan } from './agent/plan'
import { describeScreen } from './agent/outline'
import { collectContext } from './context/collect'
import { captureScreenshot } from './context/screenshot'
import { getProvider, resolveModel } from './llm'
import { ProviderError, type ChatMessage, type ContentPart } from './llm/provider'
import { copyText, pasteAnswer } from './paste'
import { hideAnnotations, showAnnotations } from './pointer'
import { buildContinue } from './prompt'
import { imagePart } from './imagePart'
import { buildTurnRequest } from './overlay/request'
import { shouldVerify, verifyResult } from './overlay/verify'
import { consumeTurnStream } from './turnStream'
import { helperActivate, helperFront } from './native/helper'
import { getApiKey } from './settings/secrets'
import { getSettings, patchSettings } from './settings/store'
import { delay } from './util'

export interface OverlayHost {
  /** Creates the window off-screen ahead of the first key press. */
  prewarm(): void
  /** Shows the window at the given size, positioned near the cursor. */
  show(height: number, width?: number): void
  /**
   * Shows it without taking focus.
   *
   * Push-to-talk uses this while it is still reading the frontmost app: a focused
   * overlay would become the "active app" the context is collected from.
   */
  showInactive(height: number, width?: number): void
  /** Resizes the window, keeping it on screen. */
  resize(height: number, width?: number): void
  /**
   * Tells the window whether shapes are painted on the screen right now, so it
   * can drop its native blur while they are: a frosted card over the very spot
   * an arrow points at would smear the thing being pointed at.
   */
  setDrawing(active: boolean): void
  /** Drops the window's blur while a voice turn shows bare bars. */
  setVoice(active: boolean): void
  /**
   * Makes the card transparent to the mouse and gives up focus, so a synthetic
   * click lands on the app the plan is about instead of on our own panel.
   */
  setPassthrough(active: boolean): void
  hide(): void
  window(): BrowserWindow | null
}

interface Session {
  id: string
  snapshot: ContextSnapshot
  flags: ContextFlags
  defaults: ContextFlags
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
   * Capped at `HISTORY_TURNS` exchanges and trimmed when it is sent, because a
   * session can stay open for a while and an unbounded history would quietly
   * grow every request until it hit the context limit.
   */
  history: Exchange[]
  /**
   * Live preview while the overlay is open: the picture is re-taken on a timer
   * so both the thumbnail and the image sent with a request show the window as
   * it is now, not as it was at the moment the overlay opened.
   */
  live: { timer: NodeJS.Timeout | null; inFlight: boolean }
  /**
   * How many "look at the screen and continue" rounds this turn has already
   * taken. Lives on the session, not on the request, because a continuation is
   * one turn with several requests and the budget is per turn.
   */
  rounds: number
}

/**
 * Size the bubble is placed with before the renderer has laid itself out: the
 * folded card — one input line and the chevron. Only placement uses it; the
 * renderer reports the real size a frame later, so a slightly generous guess here
 * just keeps the first placement from flipping sides afterwards.
 */
const INITIAL_HEIGHT = 31

/** How often the open overlay re-captures the screen behind it. */
const LIVE_REFRESH_MS = 2000

/**
 * One question and the answer it got.
 *
 * `answer` is what the user actually read — the streamed text after the marker
 * lines were stripped — so a follow-up can refer to it the way the person does.
 */
interface Exchange {
  question: string
  answer: string
}

/**
 * How many exchanges are kept. Two is the number the owner asked for, and it is
 * also the honest one: "а почему?" refers to the previous answer, and one step
 * further back is what "а до этого?" means. A longer window mostly multiplies the
 * prompt size, since each turn already carries a fresh screenshot.
 */
const HISTORY_TURNS = 2

/**
 * Ceiling for one remembered answer. A long answer is still referenced by its
 * beginning — the part the follow-up is about — and this keeps two turns of
 * history from costing more than the question itself.
 */
const MAX_HISTORY_ANSWER_CHARS = 1_500

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
    target: () => {
      const target = session?.target
      if (!target) return null
      return { bundleId: target.bundleId, pid: target.pid }
    }
  })

  /**
   * One funnel for agent state: the card and the ring at the cursor are two
   * halves of the same message.
   *
   * The card can be behind the window the plan is operating, so the step is also
   * mirrored onto the pointer — the one place the user is already looking while
   * the assistant moves it. Both sinks get every event from here, which keeps the
   * ring from disagreeing with the card about what is running.
   */
  function publishAgent(event: AgentEvent): void {
    emit(CH.agent.event, event)
    updateAgentCursor(event)
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
    if (!resolveModel(settings)) {
      return {
        kind: 'warning',
        message: `Выберите модель ${label} в настройках.`,
        action: 'openSettings'
      }
    }
    if (!getApiKey(settings.provider)) {
      return {
        kind: 'warning',
        message: `Добавьте ключ ${label} в настройках, чтобы получать ответы.`,
        action: 'openSettings'
      }
    }
    return null
  }

  function state(): OverlayState | null {
    if (!session) return null
    const settings = getSettings()
    const warnings = [...session.snapshot.warnings]
    const vision = modelSupportsVision(settings.provider, resolveModel(settings))
    if (!vision && session.flags.includeScreenshot) {
      // The drawing tool needs an image: a model without vision never receives
      // one, so it silently loses the tool. Say so instead of letting answers
      // arrive without drawings for no visible reason.
      warnings.push('Модель не принимает изображения — скриншот и рисунок недоступны.')
    }
    return {
      sessionId: session.id,
      context: session.snapshot,
      flags: session.flags,
      defaults: session.defaults,
      quickActions: settings.quickActions,
      setupNotice: setupNotice(),
      warnings,
      agent: agent.availability()
    }
  }

  function emit(channel: string, payload: unknown): void {
    const win = host.window()
    if (!win || win.isDestroyed()) return
    win.webContents.send(channel, payload)
  }

  function refresh(): void {
    const next = state()
    if (next) emit(CH.overlay.state, next)
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
    refresh()
    return agent.availability()
  }

  /** Emits the current context so the thumbnail reflects a freshly taken shot. */
  function publishContext(target: Session): void {
    if (session !== target) return
    emit(CH.overlay.contextUpdate, target.snapshot)
  }

  /**
   * Takes a new picture of the screen *right now*.
   *
   * The whole display, not the active window: the drawing tool has to be able to
   * point at the menu bar, the Dock or a second app, and a window-sized capture
   * would make those targets impossible to show. The painting layer is pinned over
   * exactly the rectangle recorded in `ScreenshotInfo.area`, so display-wide
   * coordinates stay honest.
   *
   * The overlay's own window is temporarily excluded from the capture: without
   * that, the `-R` / full-screen fallbacks would photograph our own card, and a
   * live refresh would end up feeding the model a picture of the assistant.
   * The flag is restored immediately, so the window stays screen-shareable.
   * Concurrent callers (live tick + a question asked at the same moment) share
   * one capture instead of queueing two.
   */
  let captureInFlight: { sessionId: string; promise: Promise<ScreenshotInfo | null> } | null = null

  function captureFor(target: Session): Promise<ScreenshotInfo | null> {
    if (captureInFlight && captureInFlight.sessionId === target.id) {
      return captureInFlight.promise
    }

    const run = (async (): Promise<ScreenshotInfo | null> => {
      const win = host.window()
      const visible = Boolean(win && !win.isDestroyed() && win.isVisible())
      const settings = getSettings()
      try {
        if (visible && win) {
          win.setContentProtection(true)
          // Give the compositor a beat to apply the new sharing state.
          await delay(45)
        }
        const shot = await captureScreenshot(
          {
            windowId: target.target?.windowId ?? null,
            bounds: target.target?.bounds ?? null,
            // The whole display, not one window: drawing is a tool the assistant
            // reaches for on its own, and a pointer that could only aim inside one
            // window would make "нажми на иконку в доке" impossible to show. The
            // painting layer is pinned over exactly the captured rectangle.
            fullDisplay: true
          },
          { maxSide: settings.screenshotMaxSide, quality: settings.screenshotQuality }
        )
        if (session === target) {
          if (shot) target.snapshot.screenshot = shot
          target.snapshot.screenshotPending = false
          publishContext(target)
        }
        return shot
      } finally {
        if (visible && win && !win.isDestroyed()) win.setContentProtection(false)
      }
    })()

    const entry = { sessionId: target.id, promise: run }
    captureInFlight = entry
    const clear = (): void => {
      if (captureInFlight === entry) captureInFlight = null
    }
    void run.then(clear, clear)
    return run
  }

  /**
   * Returns an image recent enough to represent "this screen right now". A shot
   * younger than `MAX_SHOT_AGE_MS` is reused so a question asked in the same
   * instant as a live tick does not pay for a second capture; anything older is
   * re-taken, because the whole point is that the model sees the screen as it is
   * now and not as it was when the overlay opened.
   */
  const MAX_SHOT_AGE_MS = 600

  async function ensureFreshScreenshot(target: Session): Promise<ScreenshotInfo | null> {
    const current = target.snapshot.screenshot
    if (current && Date.now() - current.capturedAt < MAX_SHOT_AGE_MS) return current
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
    return shot ?? target.snapshot.screenshot
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
   * frontmost, and a focused overlay would answer "Smart Cursor": the remembered
   * target, the selected text and the paste destination would all become our own
   * window. So the card is shown with `showInactive`, the context is read from the
   * app behind it, and only then does the window take the keyboard.
   */
  async function openInternal(): Promise<void> {
    const startedIn = generation
    const win = host.window()
    if (session && win?.isVisible()) {
      // Coming back to an already open card. The picture is refreshed, and so is
      // *the app the card is about*: while the card sat on screen the user moved
      // to another window, and the question they are about to type is about that
      // one. Keeping the app from the first open is how a plan ends up clicking
      // in the window the user left — `agent.execute` brings the target to the
      // front before the first step, so a stale target does not just mislabel
      // the answer, it physically raises the wrong window over the one on screen.
      //
      // The context has to be read before the focus is taken: our own card is
      // what the frontmost app becomes a moment later.
      const front = await helperFront()
      const elsewhere = front && front.pid > 0 && front.pid !== process.pid
      if (elsewhere) {
        const settings = getSettings()
        const { snapshot, flags } = await collectContext({
          excludedApps: settings.excludedApps,
          captureScreenshot: settings.captureScreenshotByDefault
        })
        if (startedIn === generation && session && !snapshot.excluded) {
          session.snapshot = snapshot
          session.target = snapshot.activeApp
          session.flags = flags
          // The drawing belonged to the previous screen.
          hideAnnotations()
          session.annotations = []
          emitAnnotations()
        }
      } else if (session.snapshot.activeApp) {
        void ensureFreshScreenshot(session)
      }
      if (startedIn !== generation) return
      win.focus()
      startLive(session)
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
    // question that has not been asked yet. Nothing else can be reading it: a
    // running plan is stopped by `close()`, and this path is only reached when the
    // window was hidden.
    session = null
    host.showInactive(INITIAL_HEIGHT)
    const shownEarly = true
    // The renderer is the same page as last time and still shows the last answer:
    // it has to be told to drop it, or a reopened card would appear to answer the
    // question before it was asked.
    emit(CH.overlay.preparing, null)

    const settings = getSettings()
    const { snapshot, flags } = await collectContext({
      excludedApps: settings.excludedApps,
      captureScreenshot: settings.captureScreenshotByDefault
    })

    // The turn ended while the context was being collected: showing the card now
    // would leave an empty panel on screen with no way to dismiss it.
    if (startedIn !== generation) {
      if (shownEarly) host.hide()
      return
    }

    if (snapshot.excluded) {
      console.log('[overlay] active app is on the exclusion list — nothing collected')
      if (shownEarly) host.hide()
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
      defaults: { ...flags },
      target: snapshot.activeApp,
      abort: null,
      requestId: null,
      answer: '',
      annotations: [],
      history: [],
      live: { timer: null, inFlight: false },
      rounds: 0
    }

    // Focus is taken only now, once the context is safely collected: the card was
    // on screen (inactive) from the first millisecond, but the keyboard goes to it
    // here, so a keystroke typed at once lands in the field and not in the user's
    // document.
    host.show(INITIAL_HEIGHT)
    emit(CH.overlay.state, state())

    // The card is on screen now, so the first capture happens while it is: the
    // live path keeps our own window out of the picture. The image is taken even
    // when the chip is off for this session (a selection exists), so the user can
    // still switch the screenshot on and get a current frame.
    const target = session
    if (settings.captureScreenshotByDefault && snapshot.activeApp) {
      void ensureFreshScreenshot(target).then(() => {
        if (session !== target) return
        const next = state()
        if (next) emit(CH.overlay.state, next)
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
    // The card's own density and the window's vibrancy both follow this number;
    // routing them through here keeps the two from ever disagreeing.
    syncDrawing()
    emit(CH.overlay.annotations, { count, visible: count > 0 })
  }

  /** Removes the drawings but keeps the card and the answer. */
  function clearPointer(): void {
    if (!session) return
    session.annotations = []
    hideAnnotations()
    emitAnnotations()
  }

  function setFlags(flags: ContextFlags): void {
    if (!session) return
    const previous = session.flags
    session.flags = {
      includeSelection: Boolean(flags.includeSelection),
      includeScreenshot: Boolean(flags.includeScreenshot)
    }
    refresh()
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
      session.annotations = []
      hideAnnotations()
      emitAnnotations()
    }
  }

  function resize(height: number, width?: number): void {
    host.resize(height, width)
  }

  /**
   * One request, streamed into the card.
   *
   * Split out of `send` because an agent turn is not one request: after a plan
   * runs, the screen has changed and the model has to look again. Both the first
   * round and the continuations need exactly this — stream, paint, collect — and
   * the only difference is which messages they start from.
   */
  async function streamRound(options: {
    messages: ChatMessage[]
    requestId: string
    maxTokens: number
    signal: AbortSignal
    canDraw: boolean
    area: ScreenRect | null
    apiKey: string
    /**
     * Collect the prose without showing it yet.
     *
     * An action turn is narrated ("нажимаю «Экспорт»…") before anything knows
     * that a plan is coming, and a card that prints the sentence while the click
     * happens behind it is noise. The caller decides once the round is parsed:
     * flush the held text for an answer, drop it for an action.
     */
    holdText: boolean
  }): Promise<{ steps: AgentPlanStep[]; text: string }> {
    const { messages, requestId, maxTokens, signal, canDraw, area, apiKey, holdText } = options
    const settings = getSettings()

    /**
     * Paints newly parsed shapes. Called as the stream arrives so the explanation
     * and the drawing grow together instead of the arrow appearing only after the
     * last token.
     *
     * Serialised through `painting`: two overlapping window updates would race,
     * and the loser could erase a shape the winner had already shown.
     */
    let painting: Promise<void> = Promise.resolve()
    const paint = (shapes: Annotation[]): void => {
      if (shapes.length === 0 || !canDraw || !area || !session) return
      const next = [...session.annotations, ...shapes]
      session.annotations = next
      emitAnnotations()
      painting = painting.then(() => showAnnotations(area, next)).catch(() => undefined)
    }

    const append = (delta: string): void => {
      if (!delta || !session) return
      if (holdText) return
      session.answer += delta
      const event: StreamEvent = { type: 'chunk', requestId, delta }
      emit(CH.overlay.stream, event)
    }

    // Everything that is not about this window — parsing, filtering, the tail —
    // lives in `consumeTurnStream`, so it can be driven by a fake provider.
    return consumeTurnStream({
      provider: getProvider(settings.provider),
      messages,
      apiKey,
      streamOptions: {
        model: resolveModel(settings) ?? '',
        temperature: settings.temperature,
        maxTokens,
        baseUrl: resolveBaseUrl(settings.provider, settings.baseUrls[settings.provider]),
        signal
      },
      isAlive: () => !signal.aborted && Boolean(session),
      onShapes: paint,
      onText: append
    })
  }

  /**
   * Shows prose that was held back while the turn might have been an action.
   *
   * The text is sent as one chunk rather than replayed token by token: it was
   * buffered precisely to avoid showing it too early, so a delayed "streaming"
   * animation would only pretend the model is still writing.
   */
  function showHeldAnswer(requestId: string, text: string): void {
    if (!text || !session) return
    session.answer += text
    const event: StreamEvent = { type: 'chunk', requestId, delta: text }
    emit(CH.overlay.stream, event)
  }

  async function send(request: SendRequest): Promise<void> {
    if (!session) return
    const settings = getSettings()
    const model = resolveModel(settings)
    const apiKey = getApiKey(settings.provider)

    const fail = (message: string, retryable: boolean): void => {
      const event: StreamEvent = { type: 'error', requestId: request.requestId, message, retryable }
      emit(CH.overlay.stream, event)
    }

    if (!model) {
      fail('Модель не выбрана. Откройте настройки и укажите модель.', false)
      return
    }
    if (!apiKey) {
      fail('Не задан ключ API. Откройте настройки и добавьте ключ.', false)
      return
    }

    // "Короче / длиннее": the previous answer is the whole input, so no context,
    // no screenshot and no selection are re-sent.
    const refine = request.refine ?? null
    const baseAnswer = refine ? refine.baseAnswer.trim() : ''
    if (refine && !baseAnswer) {
      fail('Пока нечего переписывать — сначала получите ответ.', false)
      return
    }

    session.abort?.abort()
    // A new question is a new turn: the round budget is per turn, and a plan from
    // the previous answer must not be able to keep clicking into this one.
    agent.stop()
    session.rounds = 0

    const abort = new AbortController()
    session.abort = abort
    session.requestId = request.requestId
    session.answer = ''

    const visionSupported = modelSupportsVision(settings.provider, model)

    const turn = await buildTurnRequest({
      request,
      session,
      settings,
      visionSupported,
      availability: agent.availability(),
      ensureFreshScreenshot: () => ensureFreshScreenshot(session as Session),
      describeScreen,
      aborted: () => abort.signal.aborted || !session
    })
    if (turn.abandoned) return

    const { messages, maxTokens, area, canDraw, canAct, holdFirstRound } = turn

    // The drawings belong to the answer currently on screen: a new question
    // replaces that answer, so old arrows must not stay behind as if they
    // explained the new one. A rewrite ("короче") keeps them — it is the same
    // answer in other words.
    if (!refine) {
      session.annotations = []
      hideAnnotations()
      emitAnnotations()
    }

    // The ring at the pointer belongs to the whole turn, not to one plan: a turn
    // can look at the screen again and keep going, and the mark must not blink
    // between two plans. Claimed before the first plan runs, released in `finally`
    // when the turn is over — that release is the only place it goes out.
    const ringTurn = beginAgentTurn()

    try {
      /**
       * Prose withheld from the card while this round might turn into an action.
       *
       * It is flushed only when the turn ends without a single step to perform.
       * `suppressed` is sticky: once a plan is about to run, every word of the
       * narration has already been superseded by the action itself.
       */
      let held = ''
      let suppressed = false

      let round = await streamRound({
        messages,
        requestId: request.requestId,
        maxTokens,
        signal: abort.signal,
        canDraw,
        area,
        apiKey,
        holdText: holdFirstRound
      })
      if (abort.signal.aborted || !session) return
      if (holdFirstRound) held += round.text

      // ---- agent rounds -------------------------------------------------
      //
      // A plan is executed after the stream ends, never during it: the model has
      // to finish describing what it is about to do before the screen moves under
      // the sentence it is still writing.
      let pending = normalizePlan(round.steps, { settings: settings.agent, area })

      // A plan means this turn is an action, not an answer: the narration held
      // above is dropped and the agent row becomes the only thing the card says.
      if (canAct && area && pending.steps.length > 0) {
        suppressed = true
        held = ''
      }

      // The model asked to press something but the tool was not offered (mode
      // off, no permission, no image). Its markers were stripped from the answer,
      // so without this the card would show a confident "нажимаю Экспорт" and
      // nothing would have happened — the worst kind of silence.
      if (round.steps.length > 0 && (!canAct || !area)) {
        publishAgent({
          phase: 'error',
          step: 0,
          total: round.steps.length,
          label: '',
          plan: round.steps.map((step) => step.label),
          message: canAct
            ? 'Неизвестно, где на экране цель — действие не выполнено.'
            : (agent.availability().reason ?? 'Агентный режим недоступен.')
        })
      }

      // A continuation is what the *model* asked for with `@look`, not a routine
      // second request. Most answers click one thing and stop; making every turn
      // look again would double the cost of the common case to serve the rare one.
      //
      // `performedLines` is what the whole turn did, gathered across every round
      // of it. It is written for the verification request below, which needs the
      // full list — a check that only knows about the last plan would judge a
      // half-finished sequence.
      const performedLines: string[] = []
      /**
       * Set when the runner stopped by itself: an abort, a missing permission, a
       * click that hit the wrong control. Such a turn is not verified — the card
       * already carries the reason, and a second opinion about a screen the user
       * deliberately interrupted is noise on top of an explanation.
       */
      let interrupted = false
      /**
       * Whether the model ended its plan with `@done`.
       *
       * Tracked separately from `performedLines` because the two disagree in the
       * case that most needs a check: a plan that claims success and presses
       * nothing. "Готово" with an empty list of actions is not a small claim, it
       * is the whole claim — and it is exactly what a screenshot can settle.
       */
      let claimedDone = false
      /**
       * Whether the result of a plan will be judged on a fresh screenshot.
       *
       * Known before the first plan runs, and passed down to every one of them:
       * the runner announces the end of a plan with «Готово», and in a turn that
       * ends with a check that word would be spoken before the evidence exists.
       * It is what the check is about — see `request.verify` on the runner side.
       */
      const willVerify = settings.agent.verifyResult && canAct && Boolean(area)

      while (
        (pending.steps.length > 0 || pending.wantsLook) &&
        session.rounds < settings.agent.maxSteps
      ) {
        if (!canAct || !area) break

        const hasAction = pending.steps.length > 0
        if (hasAction) {
          // Something is about to move on screen. Whatever the round wrote about
          // it is narration, not the result: the agent row reports what happened.
          suppressed = true
          held = ''
        }

        const result =
          hasAction
            ? await agent.execute({
                requestId: request.requestId,
                prompt: request.prompt,
                steps: pending.steps,
                area,
                finished: pending.finished,
                verify: willVerify,
                // Steps the plan asked for and the rules refused. They are shown
                // in the card rather than swallowed: a user who reads "нажимаю
                // Экспорт" and sees nothing happen would blame the app, not the
                // missing keystroke.
                skipped: pending.rejected.map((entry) => entry.reason)
              })
            : { finished: false, performed: [] }
        if (abort.signal.aborted || !session) return

        // Collected before any `break`: whatever ends the loop, the check below
        // has to know what the screen was asked to become.
        for (const step of result.performed) {
          performedLines.push(step.ok ? step.label : `${step.label} (не удалось)`)
        }
        // A message means the plan stopped early — a wrong target, a missing
        // permission, or "стоп" from the user — and none of those is a result to
        // check. The card already says why, and a screenshot verdict on top of it
        // would be a second, unrelated opinion.
        if (result.message) interrupted = true
        if (result.finished) claimedDone = true

        // `@done` — or a refusal to continue — ends the turn: there is nothing
        // left to look at, and asking again would just spend tokens to hear "да".
        if (result.finished || result.message || interrupted) break
        // An aborted run means the user took the mouse back. Looking again would
        // immediately take it away from them a second time. A plan that only
        // asked to look has no actions to have been interrupted, so it passes.
        if (hasAction && result.performed.length === 0) break
        // Nothing asked to look again: the turn is over.
        if (!pending.wantsLook) break

        session.rounds += 1
        const canContinue = session.rounds < settings.agent.maxSteps
        if (!canContinue) break

        // The screen is a different place now, so the picture has to be re-taken:
        // continuing to reason about the old frame is exactly how an agent clicks
        // the same button twice.
        await ensureFreshScreenshot(session)
        if (abort.signal.aborted || !session) return
        const freshArea = session.snapshot.screenshot?.area ?? area
        const shot = session.snapshot.screenshot
        const continuation = buildContinue({
          performed: result.performed.map((step) =>
            step.ok ? step.label : `${step.label} (не удалось)`
          ),
          prompt: request.prompt,
          round: session.rounds,
          canContinue: session.rounds + 1 < settings.agent.maxSteps,
          act: canAct
        })

        const continueParts: ContentPart[] = []
        if (shot) {
          const image = imagePart(shot.dataUrl)
          if (image) continueParts.push(image)
        }
        continueParts.push({ type: 'text', text: continuation.userText })

        round = await streamRound({
          messages: [
            {
              role: 'system',
              parts: [
                {
                  type: 'text',
                  text: `${settings.systemPrompt.trim()}\n\n${continuation.modeInstruction}`
                }
              ]
            },
            { role: 'user', parts: continueParts }
          ],
          requestId: request.requestId,
          maxTokens,
          signal: abort.signal,
          canDraw,
          area: freshArea,
          apiKey,
          // Only the *result* of a continuation is an answer. Holding it means a
          // second plan can still replace it with the action row.
          holdText: true
        })
        if (abort.signal.aborted || !session) return
        held += round.text

        pending = normalizePlan(round.steps, { settings: settings.agent, area: freshArea })
        if (canAct && area && pending.steps.length > 0) {
          suppressed = true
          held = ''
        }
      }

      // ---- verification -------------------------------------------------
      //
      // The word «Готово» is a promise about the screen, and up to this point
      // every promise in this turn came from the model's opinion about a
      // screenshot that its own clicks have since invalidated. So before the card
      // is allowed to say it, the screen is photographed again and the model is
      // asked one question it cannot answer from its own narration: сверь просьбу
      // с тем, что видно. If the evidence is not there, the words become "не
      // получилось, вот что на экране" instead of a success nobody saw.
      //
      // Skipped when the run was interrupted — the card already explains why the
      // action stopped, and a verdict about a screen the user deliberately took
      // back is noise — and when nothing actually ran, because then there is no
      // claim to test and the answer is already the model's prose.
      // `willVerify` is the same answer the runner was given, so the two cannot
      // disagree: exactly the turns that withheld «Готово» are the turns that get
      // checked, and a text-only answer is never sent to a screenshot it has no
      // claim about.
      if (
        shouldVerify({
          willVerify,
          interrupted,
          performed: performedLines.length,
          claimedDone
        })
      ) {
        suppressed = true
        held = ''
        // Said before the request, not after: the runner has just announced the
        // end of its plan, and the caller's turn is not over. From here until the
        // check returns, the row says what is really going on.
        publishAgent({
          phase: 'checking',
          step: 0,
          total: 0,
          label: 'Проверяю по экрану, выполнена ли просьба',
          plan: []
        })

        const check = await verifyResult({
          settings,
          requestId: request.requestId,
          prompt: request.prompt,
          apiKey,
          maxTokens,
          performedLines,
          signal: abort.signal,
          isAlive: () => Boolean(session),
          publishAgent,
          capture: () => captureFor(session as Session),
          streamRound,
          execute: (run) => agent.execute(run),
          lastPhase: () => agent.last().phase,
          delay
        })
        if (abort.signal.aborted || !session) return

        if (check.outcome === 'confirmed') {
          // Verified: the plan did what it claimed. The card says so in the agent
          // row and stays free of prose, exactly like every other action turn —
          // the evidence sentence was for us, not for the user.
          publishAgent({ phase: 'done', step: 0, total: 0, label: 'Готово', plan: [] })
        } else if (check.outcome === 'unconfirmed') {
          // Looked, and the request is not fulfilled. The row must not claim
          // success, and the model's own words — what it actually sees — are the
          // answer, because a screenshot is a better explanation than a status.
          publishAgent({
            phase: 'error',
            step: 0,
            total: 0,
            label: '',
            plan: [],
            message: 'По экрану не видно, что просьба выполнена.'
          })
          // The check's words are the answer: what is on the screen, described by
          // the model that just looked at it, instead of a status word about a
          // claim nobody could confirm. Whatever the turn narrated earlier stays
          // dropped — a plan ran, so those sentences came before it.
          suppressed = false
          held = check.evidence
        }
        // `not-run` means it never got to look (no screenshot): the check has
        // already said why, and the honest "не подтверждено" stands.
      }

      // No step ever ran: the held prose is the answer, and it can be shown now.
      // When something did run, the action is the answer and the card stays empty
      // of prose — only the agent row remains. Clearing here also covers a turn
      // whose text was already streamed before the plan became visible.
      if (suppressed) session.answer = ''
      else showHeldAnswer(request.requestId, held)

      // The turn joins the conversation only once it has actually produced
      // something. A failed request, a cancelled one or an action that ran with no
      // prose leaves no exchange behind — remembering "I clicked Export" as an
      // answer would make the next "а почему?" refer to a sentence the user never
      // saw.
      if (!suppressed) remember(request, session.answer)

      const done: StreamEvent = {
        type: 'done',
        requestId: request.requestId,
        text: session.answer,
        annotations: session.annotations.length
      }
      emit(CH.overlay.stream, done)
    } catch (error) {
      if (abort.signal.aborted) return
      if (error instanceof ProviderError) {
        fail(error.message, error.retryable)
        return
      }
      fail(error instanceof Error ? error.message : 'Неизвестная ошибка запроса.', true)
    } finally {
      if (session?.abort === abort) session.abort = null
      // The turn is over — answered, aborted, failed or closed mid-run — and this
      // is the one place the ring at the pointer is allowed to go out. Every path
      // above (a `return` included) lands here, so the mark can never be left
      // sitting on the user's cursor after the assistant stopped working.
      endAgentTurn(ringTurn)
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
  function remember(request: SendRequest, answer: string): void {
    if (!session) return
    const question = request.prompt.trim()
    const reply = answer.trim()
    if (!question || !reply) return

    const entry: Exchange = {
      question,
      answer:
        reply.length > MAX_HISTORY_ANSWER_CHARS
          ? `${reply.slice(0, MAX_HISTORY_ANSWER_CHARS)}…`
          : reply
    }
    const last = session.history[session.history.length - 1]
    if (request.refine && last) {
      last.answer = entry.answer
    } else {
      session.history.push(entry)
    }
    // Oldest first out: the last `HISTORY_TURNS` exchanges are what a follow-up
    // can refer to, and everything older only costs tokens.
    if (session.history.length > HISTORY_TURNS) {
      session.history.splice(0, session.history.length - HISTORY_TURNS)
    }
  }

  async function copy(text: string): Promise<{ ok: boolean }> {
    await copyText(text)
    return { ok: true }
  }

  async function paste(text: string): Promise<PasteResult> {
    const target = session?.target ?? null
    // The drawing pointed at something the user has now acted on: leaving it up
    // would cover the very text we are pasting.
    if (session) session.annotations = []
    hideAnnotations()
    emitAnnotations()
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
  function deliver(text: string, send: boolean): void {
    const push = (): void => emit(CH.voice.transcript, { text, send })
    if (opening) {
      void opening.then(push, push)
      return
    }
    push()
  }

  return {
    open,
    close,
    state,
    setFlags,
    clearPointer,
    setTyping,
    setVoice: (active: boolean) => host.setVoice(active),
    resize,
    send,
    cancel,
    copy,
    paste,
    deliver,
    emit,
    agentAvailability: () => agent.availability(),
    setAgentEnabled,
    stopAgent: () => agent.stop(),
    target: (): ActiveAppInfo | null => session?.target ?? null,
    isOpen: (): boolean => Boolean(session && host.window()?.isVisible()),
    hasSession: (): boolean => session !== null
  }
}

export type OverlayController = ReturnType<typeof createOverlayController>