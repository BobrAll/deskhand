/**
 * The overlay session: everything between "hotkey pressed" and "overlay hidden".
 *
 * Flow (ТЗ §4): remember the frontmost app -> collect context -> show the
 * overlay next to the cursor -> stream the answer -> copy / retry / close.
 */

import { randomUUID } from 'node:crypto'
import type { BrowserWindow } from 'electron'
import { CH } from '@shared/ipc'
import type { AgentAvailability, AgentEvent, ContextFlags, StreamEvent } from '@shared/types'
import { createAgentController } from '../agent'
import { updateAgentCursor } from '../agent/cursor'
import { paintAgentPresentation, updateAgentPresentation } from '../agent/presentation'
import { collectContext } from '../context/collect'
import { CARD_FOLDED_HEIGHT } from '../card'
import { copyText } from '../paste'
import { createTurnRunners } from './turnRunners'
import type { Session } from './session'
import { createDictation } from './dictation'
import { createTurnController } from './turnController'
import { createAnnotations } from './annotations'
import { createFocusReturn } from './focus'
import { createLiveCapture } from './liveCapture'
import { createOverlayState } from './state'
import { trace } from '../agent/trace'
import type { OverlayHost } from './host'
import { helperFrontApplication } from '../native/helper'
import { getSettings, patchSettings } from '../settings/store'

/** One `open()` that is still collecting context, and the generation it started in. */
interface OpenRun {
  generation: number
  promise: Promise<void>
}

/**
 * Size the card is placed with before the renderer has laid itself out.
 *
 * Only placement uses it; the renderer reports the real size a frame later, so a
 * slightly generous guess here just keeps the first placement from flipping
 * sides afterwards.
 */
const INITIAL_HEIGHT = CARD_FOLDED_HEIGHT

export function createOverlayController(host: OverlayHost) {
  let session: Session | null = null
  const { setTyping, resetDrawing, clearAnnotations, discardAnnotations, createPainter } = createAnnotations({
    current: () => session,
    setDrawing: (drawing) => host.setDrawing(drawing),
    publishCount: (count) => sendToWindow(CH.overlay.annotations, { count })
  })
  const { ensureFreshScreenshot, startLive, stopLive, windowStillMatches, observedAppFor } = createLiveCapture<Session>(
    {
      window: () => host.window(),
      isCurrent: (target) => session === target,
      publishContext,
      hasAnnotations: (target) => target.annotations.length > 0,
      onCaptureUnavailable: discardAnnotations
    }
  )
  /**
   * Which card owns the screen, as a counter.
   *
   * Bumped by every `close()` and by every fresh `open()`. `open()` takes a long
   * time (app, selection and screenshot) and the user can finish speaking, and
   * release the key, while it is still collecting; without this the card would
   * appear *after* the turn was already closed — an empty panel left floating at
   * the pointer with nothing ever going to fill it. The same number is what
   * tells a slow follow-up (a focus hand-back, a doomed collection) that a newer
   * card has taken over.
   */
  let generation = 0

  /**
   * The `open()` currently collecting context, if any, with the generation it
   * was started in.
   *
   * A voice transcript can be ready before the card is: the window is shown
   * immediately on the key press, but the app and the selection still have to be
   * read. Delivering into that gap would put the phrase into the *previous*
   * session (or into no session at all), so `deliver` waits for this to settle.
   *
   * The generation travels with the record because a `close()` during collection
   * dooms the open that is already running: joining it on the next press would
   * hand that press a card which is about to be taken down by its own generation
   * check. See `currentOpen`.
   */
  let opening: OpenRun | null = null
  const dictation = createDictation({
    invalidatePendingOpen: () => {
      if (opening) generation += 1
    },
    cardOnScreen,
    cardTarget: () => session?.target ?? null,
    showField: (frame) => host.showField(frame),
    hideField: () => host.hideField(),
    closeCard: close,
    hideCard: () => host.hide()
  })

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
    focus: () => host.focus(),
    hasFocus: () => Boolean(host.window()?.isFocused()),
    emit: (event: AgentEvent) => publishAgent(event),
    present: (action) => paintAgentPresentation(action)
  })

  const { overlayState } = createOverlayState({
    current: () => session,
    availability: () => agent.availability()
  })

  /** Keeps the card and the display layer in sync with the agent's state. */
  function publishAgent(event: AgentEvent): void {
    trace('agent.phase', {
      phase: event.phase,
      step: event.step,
      total: event.total,
      completed: event.completed === true,
      calls: event.actions?.length ?? 0
    })
    sendToWindow(CH.agent.event, event)
    updateAgentCursor(event)
    // The ghost pointer follows the run, not the step: it is present from
    // `arming` to the terminal phase and waits between actions.
    updateAgentPresentation(event)
  }

  function sendToWindow(channel: string, payload: unknown): void {
    const win = host.window()
    if (!win || win.isDestroyed()) return
    win.webContents.send(channel, payload)
  }

  /** Whether the card is on screen right now, session and window together. */
  function cardOnScreen(): boolean {
    const win = host.window()
    return Boolean(session && win && !win.isDestroyed() && win.isVisible())
  }

  /**
   * Whether `owner` is still the generation that owns the screen.
   *
   * Both `close()` and a fresh `open()` bump the counter, so this one comparison
   * answers "did anything take the card away while the slow work was running".
   */
  function isCurrentGeneration(owner: number): boolean {
    return owner === generation
  }

  const { returnFocusTo } = createFocusReturn({
    window: () => host.window(),
    isCurrent: isCurrentGeneration
  })

  /**
   * The open a press or a transcript may join, if there is one.
   *
   * Only an open of the current generation is joinable: one that was already
   * running when the card closed is doomed — it will find itself outdated and
   * hide the window — so a press after Escape starts a fresh collection instead
   * of inheriting that one.
   */
  function currentOpen(): OpenRun | null {
    return opening && isCurrentGeneration(opening.generation) ? opening : null
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

  /**
   * Opens the card, sharing one collection between concurrent callers.
   *
   * The hotkey, push-to-talk and the tray all want the same card; running
   * `collectContext` twice at once would show the second session over the first.
   * Only an open that still owns the screen is shared (see `currentOpen`); a
   * press after Escape starts a fresh collection and leaves the doomed one to
   * settle on its own — it can no longer clear `opening`, which belongs to the
   * newer open.
   */
  function open(): Promise<void> {
    const joined = currentOpen()
    if (joined) {
      // A second press joining an open that is still collecting still gets the
      // card on screen immediately: the session can arrive later.
      host.showInactive(INITIAL_HEIGHT)
      return joined.promise
    }
    // A fresh open starts a new card on the screen. Its own generation is what
    // tells a close from the previous one (a focus hand-back still in flight,
    // for instance) that its work is no longer current.
    generation += 1
    const startedIn = generation
    const task = openInternal(startedIn)
    opening = { generation: startedIn, promise: task }
    const done = (): void => {
      if (opening?.promise === task) opening = null
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
      if (isCurrentGeneration(startedIn) && session && snapshot.excluded) {
        session.target = null
        close()
        return
      }
      if (isCurrentGeneration(startedIn) && session) {
        session.snapshot = snapshot
        session.target = snapshot.activeApp
        session.flags = flags
        // The drawing belonged to the previous screen.
        discardAnnotations()
      }
    } else if (session && session.snapshot.activeApp) {
      void ensureFreshScreenshot(session)
    }
    if (!isCurrentGeneration(startedIn) || dictation.isActive() || !session) return
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
  async function openInternal(startedIn: number): Promise<void> {
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
        if (!dictation.isActive() && isCurrentGeneration(startedIn)) host.show(INITIAL_HEIGHT)
      }
    })

    // The turn ended while the context was being collected, or a dictation took
    // the screen: showing the card now would leave an empty panel on screen with
    // no way to dismiss it, or take the keyboard from the user's own field. A
    // dictation is the one case that hides nothing — the same window is already
    // showing its bars.
    if (!isCurrentGeneration(startedIn) || dictation.isActive()) {
      // A newer open may already own the window (the press that followed the
      // close that doomed this one): hiding it here would take down the card
      // that press just put up. Only the newest open may hide what it showed.
      if (!dictation.isActive() && opening?.generation === startedIn) host.hide()
      return
    }

    if (snapshot.excluded) {
      console.log('[overlay] active app is on the exclusion list — nothing collected')
      host.hide()
      return
    }

    // A new session starts with a clean screen even if the previous one left a
    // drawing visible for a moment before it was closed.
    resetDrawing()

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
    const closedIn = generation
    // Remembered before the session is torn down: this is the app the keyboard
    // has to go back to (see `returnFocusTo`). The flag matters because `close()`
    // is also called for a card that was never open (a voice turn that ends in
    // dictation mode), and stealing focus then would be the opposite of help.
    const target = session?.target ?? null
    const wasOpen = cardOnScreen()
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
    resetDrawing()
    host.hide()
    if (!wasOpen) return
    // The card took the keyboard when it opened (that is how the field is typed
    // into), and hiding the window does not give it back: macOS leaves the key
    // with an application that no longer has a window, so the user types into
    // nothing. Escape means "done, back to my work", not "the assistant is in the
    // way" — so focus is handed back explicitly.
    void returnFocusTo(target, closedIn)
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

  function resize(height: number, width?: number, pin?: boolean, writing?: boolean): void {
    host.resize(height, width, pin, writing)
  }

  const runners = createTurnRunners({
    agent,
    isCurrent: (target) => session === target,
    hasSession: () => Boolean(session),
    ensureFreshScreenshot,
    observedAppFor,
    windowStillMatches,
    publishState,
    revealCard: () => {
      if (!host.window()?.isVisible()) host.showInactive(INITIAL_HEIGHT)
    },
    createPainter,
    appendText: (requestId, delta, revealText) => {
      if (!delta || !session) return
      const hadAnswer = session.answer.trim().length > 0
      session.answer += delta
      const event: StreamEvent = { type: 'chunk', requestId, delta }
      sendToWindow(CH.overlay.stream, event)
      if (revealText && !hadAnswer && session.answer.trim()) host.showInactive(INITIAL_HEIGHT)
    }
  })

  const { send, cancel, stopAgent, abortSpokenTurn } = createTurnController({
    currentSession: () => session,
    agent,
    runners,
    cardVisible: () => host.window()?.isVisible(),
    showCard: () => host.showInactive(INITIAL_HEIGHT),
    hideCard: () => host.hide(),
    discardAnnotations,
    emitStream: (event) => sendToWindow(CH.overlay.stream, event),
    publishAgent
  })

  function setVoice(active: boolean): void {
    if (active) abortSpokenTurn()
    host.setVoice(active)
  }

  async function copy(text: string): Promise<{ ok: boolean }> {
    await copyText(text)
    return { ok: true }
  }

  /**
   * Puts recognised speech into the card.
   *
   * When the card is closed the text still has to go somewhere, so it opens as
   * usual and the renderer receives the transcript through `CH.voice.transcript`
   * once its state is ready — that wiring lives in the voice controller's host.
   * If the open is still collecting context, the transcript waits for it: the
   * renderer would otherwise ask the *previous* session (or no session at all).
   *
   * A phrase whose card is gone by the time it is recognised is dropped. Escape
   * closes the card without cancelling recognition (the native tap reports a
   * cancel only while the key is held), so the transcript arrives after the user
   * already dismissed the question: typing it into the hidden renderer would
   * bring the card back with an answer to the phrase they just closed.
   */
  function deliver(text: string, { submit }: { submit: boolean }): void {
    const push = (): void => {
      // A close while the open was still collecting dooms it: the wait ends with
      // no card on screen, and the text has nowhere honest to go.
      if (!cardOnScreen()) return
      sendToWindow(CH.voice.transcript, { text, send: submit })
    }
    const joined = currentOpen()
    if (joined) {
      void joined.promise.then(push, push)
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
    beginDictation: dictation.beginDictation,
    endDictation: dictation.endDictation,
    showVoiceIndicator: () => host.showInactive(INITIAL_HEIGHT),
    resize,
    send,
    cancel,
    copy,
    deliver,
    emit: sendToWindow,
    agentAvailability: () => agent.availability(),
    setAgentEnabled,
    /** Answers the question the card is showing, if it is still the same one. */
    answerAgent: (id: string, allow: boolean, remember: boolean) => agent.answer(id, allow, remember),
    /** Ends the agent process; called on quit so none outlives the window. */
    disposeAgent: () => agent.dispose(),
    stopAgent,
    target: dictation.target,
    isOpen: (): boolean => cardOnScreen()
  }
}

export type OverlayController = ReturnType<typeof createOverlayController>
