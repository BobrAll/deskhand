/**
 * The overlay UI (ТЗ §8).
 *
 * A card, not a window: one line for the question, the answer printed directly
 * underneath it. It appears next to the cursor (the main process owns the
 * placement) as *only* that line plus one small chevron; context tags and the answer's secondary commands stay folded behind the chevron, so
 * the common case — ask, read, paste — is a small rectangle that never covers the
 * screen.
 *
 * Keyboard: Enter sends, Cmd/Ctrl+Enter pastes, Esc closes, Cmd/Ctrl+C copies the
 * answer when nothing is selected.
 *
 * Width is the one thing the card lets a person overrule. It sizes itself to its
 * content up to `CARD_WIDTH`, which is right for a sentence and wrong for a table;
 * the right edge can be dragged, and «Шире» does the same thing in one click. The
 * decision itself lives in `cardWidth.ts`.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react'
import type {
  AgentEvent,
  AgentToolRequest,
  ContextSnapshot,
  OverlayState,
  RefineDirection,
  ResponseMode,
  StreamEvent
} from '@shared/types'
import { CARD_WIDTH } from '@shared/metrics'
import { looksLikeAction } from '@shared/intent'
import { FIELD_FONT } from './cardMetrics'
import { layoutCard } from './cardLayout'
import { REFINE_HINT, REFINE_LABEL } from './copy'
import { useSpeech } from './useSpeech'
import { useWaiting } from './useWaiting'
import { useVoice } from './useVoice'
import { deriveView } from './viewFlags'
import { agentLabel, agentMark } from './agentRow'
import { keyPolicy, type KeyAction } from './keyPolicy'
import { routeStream } from './streamRouting'
import { Markdown } from './markdownText'
import { LiveThumb } from './LiveThumb'
import { draggedWidth, expandedWidth } from './cardWidth'

interface Failure {
  message: string
  retryable: boolean
}

/** The bars on the voice surface. */
const VOICE_BARS = 5
/** The bars' resting height and how much of the microphone level they add. */
const VOICE_AMP_BASE = 0.62
const VOICE_AMP_PER_LEVEL = 0.55

/**
 * How long an agent run works before the voice says it is still going.
 *
 * Long enough that a normal run never reaches it, short enough that a person
 * waiting on a stuck step hears something before they conclude it died.
 */
const AGENT_PROGRESS_MS = 45_000

function newRequestId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

export function App() {
  const speech = useSpeech()
  const speechRef = useRef(speech)
  speechRef.current = speech
  const [state, setState] = useState<OverlayState | null>(null)
  const [prompt, setPrompt] = useState('')
  const [answer, setAnswer] = useState('')
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<Failure | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  /** The copy button says it worked, then goes back to being a command. */
  const [copied, setCopied] = useState(false)
  const copiedTimerRef = useRef<number | null>(null)
  /** How many shapes are painted on the screen right now. */
  const [drawn, setDrawn] = useState(0)
  /**
   * Set as soon as the user writes anything into the field.
   *
   * The see-through state exists so the card stops hiding what the arrow points
   * at — but the moment the user starts typing, they are reading and editing the
   * card itself, and a 40% panel is the wrong thing to type into. So typing wins
   * over drawing: the card goes back to full density and the drawing stays.
   */
  const [typing, setTyping] = useState(false)
  /** The resize listener is registered once; it reads the latest typing state. */
  const typingRef = useRef(false)
  /**
   * The width the user chose for this card, or `null` while it sizes itself.
   *
   * It is state of the card and not of the settings: widening is something a
   * person does while reading one answer, and a preference that outlived the
   * answer would open the next short reply as a 560-point panel.
   */
  const [userWidth, setUserWidth] = useState<number | null>(null)
  /** A width drag is in flight; `report` outlives a render, so it reads a ref. */
  const draggingRef = useRef(false)
  const dragRef = useRef<{ startX: number; startWidth: number; width: number } | null>(null)
  const [dragging, setDragging] = useState(false)
  /**
   * The card opens as a single small field. Everything else — context tags,
   * status rows and the answer's action strip — lives behind the
   * small chevron, so the common "ask and paste" case stays one line tall.
   */
  const [expanded, setExpanded] = useState(false)
  /**
   * What the mouse and keyboard are doing right now.
   *
   * It is state of its own rather than part of the answer because a run is not a
   * piece of text: it continues after the last token has arrived, it can be
   * stopped, and it needs to be visible while the answer is still being read.
   */
  const [agent, setAgent] = useState<AgentEvent | null>(null)
  const [last, setLast] = useState<{
    prompt: string
    mode: ResponseMode
    /** Set when the last request was a rewrite, so "Повторить" repeats that. */
    refine: RefineDirection | null
    /** Answer the last rewrite started from — retries must not chain partials. */
    base: string
    /** True when the last prompt was spoken, so a retry keeps its suppression. */
    spoken: boolean
  } | null>(null)

  const stateRef = useRef<OverlayState | null>(null)
  /**
   * The field's text, readable from the state callbacks.
   *
   * The session for a freshly opened card arrives while the user may already be
   * typing into it, and those callbacks run outside a render: reading `prompt`
   * there would see whatever the last render happened to close over.
   */
  const promptRef = useRef('')
  /** Latest agent phase, so the key handler does not resubscribe on every tick. */
  const agentRef = useRef<AgentEvent | null>(null)
  /**
   * The answer on screen, readable from callbacks that must stay stable.
   *
   * The answer grows once per streamed chunk, so any callback that closes over
   * it is rebuilt on every chunk. The key handler is one of those callbacks:
   * depending on the answer would re-register the window listener hundreds of
   * times per reply.
   */
  const answerTextRef = useRef('')
  /**
   * What the turn in flight is: spoken or typed, an action or a question.
   *
   * The speech gate needs it after the turn is over — by the time a run ends,
   * the card no longer holds the prompt that started it.
   */
  const turnKindRef = useRef({ spoken: false, action: false })
  /** True when the user ended the run themselves, so its stop is not news. */
  const stoppedByUserRef = useRef(false)
  /** The approval question already announced, so a repaint does not repeat it. */
  const approvalSaidRef = useRef<string | null>(null)
  /** Pending "still working" line for a long agent run; one per acting phase. */
  const progressTimerRef = useRef<number | null>(null)
  const busyRef = useRef(false)
  const requestIdRef = useRef<string | null>(null)
  /**
   * A request that was abandoned when a voice turn started.
   *
   * Its late chunks must not land in the card after the transcript cleared it:
   * the question they answer is no longer the question on screen.
   */
  const ignoredRequestRef = useRef<string | null>(null)
  /** Latest `send`, so the voice listener does not resubscribe on every render. */
  const sendRef = useRef<(text: string, spoken?: boolean) => void>(() => {})
  /**
   * A spoken command that arrived before the turn's state did.
   *
   * The overlay can be opened by the key press itself, so a fast phrase can land
   * as a transcript while `state` is still being collected. Sending then would
   * be dropped for lack of a session; this remembers the phrase until the state
   * arrives, and only then asks.
   */
  const pendingAutoSendRef = useRef<string | null>(null)
  const inputRef = useRef<HTMLTextAreaElement | null>(null)
  const answerRef = useRef<HTMLDivElement | null>(null)
  /**
   * The font the field renders in, resolved from the live element.
   *
   * The measuring canvas has to shape the question exactly as the textarea does,
   * and the element's own computed style is the only honest source for that: the
   * font arrives from `base.css`, and macOS may resolve the family differently
   * from what the stylesheet names. The ref callback refreshes it whenever the
   * field is mounted — which is also the only time the answer can change.
   */
  const fontRef = useRef(FIELD_FONT)
  const fieldRef = useCallback((node: HTMLTextAreaElement | null) => {
    inputRef.current = node
    if (!node) return
    node.focus()
    const style = window.getComputedStyle(node)
    fontRef.current =
      style.font || `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`
  }, [])
  /**
   * The card's outermost element, as state rather than a ref.
   *
   * There are two different roots — the voice bars and the card — and React mounts
   * a new element when the component switches between them. A `useRef` would still
   * point at the detached one, and the ResizeObserver would keep watching a node
   * that is no longer on screen: the window would then be sized by whichever root
   * happened to exist when the effect last ran.
   */
  const [rootNode, setRootNode] = useState<HTMLDivElement | null>(null)
  const rootRef = useCallback((node: HTMLDivElement | null) => setRootNode(node), [])
  /** A refine keeps the old answer on screen until the first new chunk lands. */
  const replaceOnChunkRef = useRef(false)
  /**
   * True while the field holds a spoken phrase that was sent automatically.
   *
   * A transcript stays in the field for the moment between "sent" and "the answer
   * starts arriving": it is the only confirmation of what was heard, and it
   * disappears right after, once the answer is there to read instead. The typed
   * path does not need this — the user wrote the question themselves and has
   * already seen it.
   */
  const spokenPromptRef = useRef(false)

  stateRef.current = state
  promptRef.current = prompt
  answerTextRef.current = answer
  busyRef.current = busy
  agentRef.current = agent
  typingRef.current = typing

  /**
   * Applies a state broadcast. A *new* session replaces the card completely; the
   * same session re-broadcast (context/warnings refreshed after a live capture)
   * must not throw away what the user has already typed or the answer on screen.
   */
  const sessionIdRef = useRef<string | null>(null)

  /** Asks the phrase that arrived before the session once the session exists. */
  const resumePendingSend = useCallback(() => {
    const text = pendingAutoSendRef.current
    if (!text) return
    pendingAutoSendRef.current = null
    // A freshly collected session starts with an empty field; the spoken phrase
    // still has to be visible while the answer runs.
    setPrompt(text)
    // `send` reads `stateRef`, which was updated synchronously above; the timeout
    // only lets the state render land first so the card shows what was heard.
    window.setTimeout(() => sendRef.current(text, true), 0)
  }, [])

  /**
   * Everything one turn leaves behind, cleared in one place.
   *
   * Both ways a card can be replaced — a fresh session (`reset`) and a session
   * that has not been collected yet (`onPreparing`) — have to drop the same
   * fields, and a width the person dragged belongs to the card they dragged it
   * on, not to the next one.
   */
  const clearTurn = useCallback((typing: boolean) => {
    setAnswer('')
    setFailure(null)
    setNotice(null)
    setCopied(false)
    if (copiedTimerRef.current !== null) {
      window.clearTimeout(copiedTimerRef.current)
      copiedTimerRef.current = null
    }
    setBusy(false)
    setDrawn(0)
    setTyping(typing)
    setExpanded(false)
    setUserWidth(null)
    requestIdRef.current = null
    replaceOnChunkRef.current = false
    spokenPromptRef.current = false
    turnKindRef.current = { spoken: false, action: false }
    stoppedByUserRef.current = false
    setAgent(null)
  }, [])

  const reset = useCallback(
    (next: OverlayState) => {
      /**
       * What the user typed while the card was waiting for its session.
       *
       * The card is on screen and focusable before the context exists, so a fast
       * typist can be halfway through a question when the session finally lands.
       * Clearing the field here — as a fresh session normally does — would delete
       * that sentence at the exact moment it became sendable.
       */
      const typedWhileEmpty = stateRef.current === null && promptRef.current.length > 0
      speechRef.current.stop()
      sessionIdRef.current = next.sessionId
      // Imperative readers (`send`) must see the new session immediately: a queued
      // transcript can be sent before React has re-rendered.
      stateRef.current = next
      setState(next)
      if (!typedWhileEmpty) setPrompt('')
      clearTurn(typedWhileEmpty)
      inputRef.current?.focus()
      resumePendingSend()
    },
    [clearTurn, resumePendingSend]
  )

  const applyState = useCallback(
    (next: OverlayState) => {
      if (sessionIdRef.current === next.sessionId) {
        stateRef.current = next
        setState(next)
        resumePendingSend()
        return
      }
      reset(next)
    },
    [reset, resumePendingSend]
  )

  /**
   * What the voice says when a run ends.
   *
   * Two shapes, and they are not the same sentence. An answer with text in it is
   * read (and a failed run is read as a failure). A run that ended without a
   * textual answer says how it ended from the recorded bank instead — a stop the
   * user asked for is not news, they pressed Escape and are looking at the card,
   * so that one is silent.
   */
  const finishTurnSpeech = useCallback(
    (requestId: string, text: string, result: AgentEvent | null) => {
      const speech = speechRef.current
      if (!result) {
        void speech.finish(requestId, text, false)
        return
      }
      if (text.trim()) {
        void speech.finish(requestId, text, result.phase === 'error' || result.completed === false)
        return
      }
      void speech.finish(requestId, '')
      if (result.phase === 'aborted' && stoppedByUserRef.current) return
      // The line comes from the bank rather than from a literal, so it rotates and
      // so a run that ended without an answer is not read as «Готово» by a
      // different voice.
      const cue = result.phase === 'aborted' ? 'stopped'
        : result.phase === 'error' ? 'failed'
        : result.completed ? 'done' : 'incomplete'
      speech.say(cue, turnKindRef.current)
    },
    []
  )

  /**
   * Reacts to stream events. `done` is the authoritative final text; a rewrite in
   * flight keeps the previous answer visible until the first chunk arrives.
   */
  const onStream = useCallback((event: StreamEvent) => {
    // Which events belong to this card is decided in `streamRouting.ts`; the refs
    // stay here because they are one piece of coupled state, not four.
    const action = routeStream(event, {
      requestId: requestIdRef.current,
      ignoredRequest: ignoredRequestRef.current,
      replaceOnChunk: replaceOnChunkRef.current,
      spokenPrompt: spokenPromptRef.current
    })
    if (action.kind === 'ignore') return

    // The spoken phrase was there to confirm what was heard while the model
    // thought. From the first sign of an answer it is the leftover question every
    // follow-up had to be appended to, so it goes — on any event that gets here,
    // including one that never streamed.
    if (action.clearSpoken) {
      spokenPromptRef.current = false
      setPrompt('')
    }

    if (action.kind === 'append') {
      void speechRef.current.append(event.requestId, action.text)
      setAnswer((prev) => prev + action.text)
      return
    }
    if (action.kind === 'replace') {
      replaceOnChunkRef.current = false
      setAnswer(action.text)
      return
    }
    const speechCurrent = requestIdRef.current === event.requestId
    requestIdRef.current = null
    replaceOnChunkRef.current = false
    setBusy(false)
    if (action.kind === 'done') {
      if (speechCurrent) finishTurnSpeech(event.requestId, action.text, agentRef.current)
      setAnswer(action.text)
    } else {
      if (speechCurrent) {
        if (action.code === 'timeout') {
          // The recorded line already says "the result is not confirmed, check
          // what happened", which is the whole point of C7 — and it plays
          // instantly, unlike a synthesised sentence.
          void speechRef.current.finish(event.requestId, '')
          speechRef.current.say('timeout', turnKindRef.current)
        } else {
          void speechRef.current.finish(event.requestId, action.message, true)
        }
      }
      setFailure({ message: action.message, retryable: action.retryable })
    }
  }, [finishTurnSpeech])

  /**
   * Permissions and availability are changed in another window.
   *
   * The card can be open the whole time — the user goes to System Settings,
   * grants Accessibility, and comes back to the same card. Without a pull on
   * focus it keeps saying «нужен доступ» until it is closed and reopened.
   */
  useEffect(() => {
    const refresh = (): void => {
      void window.deskhand.overlay
        .getState()
        .then((next) => { if (next) applyState(next) })
        .catch(() => undefined)
    }
    window.addEventListener('focus', refresh)
    return () => window.removeEventListener('focus', refresh)
  }, [applyState])

  useEffect(() => {
    return () => {
      if (copiedTimerRef.current !== null) window.clearTimeout(copiedTimerRef.current)
    }
  }, [])

  useEffect(() => {
    // No session yet means the card is the empty one drawn while the context is
    // being collected — and it must *not* take the keyboard here. Focusing the
    // field would make this window the frontmost app, and `collectContext` reads
    // the frontmost app: the target would come back as the assistant itself. The
    // focus is taken in `reset`, once the session it belongs to exists.
    void window.deskhand.overlay.getState().then((next) => {
      if (next) applyState(next)
    }).catch(() => undefined)

    const offState = window.deskhand.overlay.onState(applyState)
    const offPreparing = window.deskhand.overlay.onPreparing(() => {
      // The card is on screen, but the session it will show does not exist yet.
      // Dropping the previous turn here is what keeps the early window an empty
      // card instead of a stale answer that looks like an instant reply.
      //
      // The field is *not* cleared when it was already empty of a session: the
      // user can reach the card before the context does, and those first letters
      // are the question — the same ones `reset` then has to keep.
      const joinedCollecting = stateRef.current === null
      sessionIdRef.current = null
      stateRef.current = null
      setState(null)
      if (!joinedCollecting) setPrompt('')
      clearTurn(false)
    })
    const offContext = window.deskhand.overlay.onContextUpdate((snapshot: ContextSnapshot) => {
      setState((prev) => (prev ? { ...prev, context: snapshot } : prev))
    })
    const offStream = window.deskhand.overlay.onStream(onStream)
    const offAnnotations = window.deskhand.overlay.onAnnotations((event) => {
      setDrawn(event.count)
    })
    const offAgent = window.deskhand.agent.onEvent((event) => {
      agentRef.current = event.phase === 'idle' ? null : event
      setAgent(agentRef.current)
      // The voice follows the states the card does not announce by itself. What
      // may actually be said is decided by `speaksCue`, from the settings.
      const kind = turnKindRef.current
      if (event.code === 'secret') speechRef.current.say('secret', kind)
      else if (event.code === 'blocked') speechRef.current.say('agentBlocked', kind)
      if (event.phase === 'asking' && event.approval) {
        // Once per question: a repaint of the same approval is not a new one.
        if (approvalSaidRef.current !== event.approval.id) {
          approvalSaidRef.current = event.approval.id
          speechRef.current.say('approval', kind)
        }
      }
      if (event.phase === 'acting') {
        progressTimerRef.current ??= window.setTimeout(() => {
          progressTimerRef.current = null
          speechRef.current.say('agentProgress', turnKindRef.current)
        }, AGENT_PROGRESS_MS)
      } else if (progressTimerRef.current !== null) {
        window.clearTimeout(progressTimerRef.current)
        progressTimerRef.current = null
      }
    })

    return () => {
      offState()
      offPreparing()
      offContext()
      offStream()
      offAnnotations()
      offAgent()
      if (progressTimerRef.current !== null) window.clearTimeout(progressTimerRef.current)
      progressTimerRef.current = null
    }
  }, [applyState, onStream])

  // Restore blur while typing, even if annotations are still visible.
  useEffect(() => {
    window.deskhand.overlay.setTyping(typing)
  }, [typing])

  /**
   * Push-to-talk. Recording and the level meter live in this window (it is the
   * one with the microphone grant); the decision to start comes from the tap in
   * the main process.
   */
  const voice = useVoice()

  /**
   * Speaking is a new question: an answer that is still streaming belongs to the
   * question before it. Dropping it here is what keeps a late chunk from landing
   * under the transcript after the bars are gone.
   */
  useEffect(() => {
    if (voice.phase !== 'listening') return
    speechRef.current.stop()
    const id = requestIdRef.current
    if (!id) return
    ignoredRequestRef.current = id
    requestIdRef.current = null
    setBusy(false)
    setFailure(null)
    setAgent(null)
    window.deskhand.overlay.cancel(id)
  }, [voice.phase])

  /**
   * While a turn runs the card *is* the indicator: the field is replaced by the
   * bars — same window, same place, no background. There is no second window at
   * the cursor: one surface, one animation.
   */
  const listening = voice.phase !== 'idle'
  /** The bars open with the voice; the meter arrives at ~10 Hz, hence the transition. */
  const amp = voice.phase === 'listening' ? VOICE_AMP_BASE + voice.level * VOICE_AMP_PER_LEVEL : 1

  /**
   * Whether there is anything to read. A model that produced only whitespace has
   * not answered, and an empty answer box on a voice turn is exactly the "answer
   * shown when there was none" this is meant to avoid.
   */
  const hasAnswer = answer.trim().length > 0

  // Drawers and confirmations need room for controls. Progress and answers
  // size to their content.
  const waiting = useWaiting(requestIdRef.current, busy && !failure && !listening)
  const waitStage = waiting.stage

  /**
   * A2: a wait long enough that the card may have been forgotten.
   *
   * Only a spoken turn reaches this: a typed question leaves the card on screen
   * with the same sentence already in it, and `speaksCue` says so.
   */
  useEffect(() => {
    if (waitStage !== 'long') return
    speechRef.current.say('longWait', turnKindRef.current)
  }, [waitStage])

  /** D1–D5: the press is over and the user is waiting to hear what happened. */
  useEffect(() => {
    if (!voice.code) return
    speechRef.current.say(voice.code)
  }, [voice.code, voice.at])
  const agentRunning = busy && agent !== null
  const agentStatus = agent && agentLabel(agent, answer)
  const agentHint = agentRunning && agent?.phase !== 'asking' ? 'Esc — остановить' : null
  const agentDone = !busy && !hasAnswer && agent !== null && agentMark(agent) === 'done'
  const showWaiting = waitStage !== 'quiet' && !hasAnswer && !agent
  const wantsWide = (expanded && !agentRunning) || Boolean(failure) ||
    agent?.phase === 'asking' || showWaiting

  /**
   * The width the card takes, and whether the question wraps in it.
   *
   * The composition lives in `cardLayout.ts`, where it can be checked without a
   * card. The one input that is not state is the field's font: it has to be the
   * live element's own computed style, because macOS may resolve the family
   * differently from what the stylesheet names.
   */
  const { width: cardWidth, wrapped, naturalWidth } = layoutCard({
    prompt,
    font: fontRef.current,
    answer,
    hasAnswer,
    busy,
    speaking: speech.speaking,
    agentStatus,
    agentHint,
    agentRunning,
    listening,
    wantsWide,
    // While a drag runs the width lives in a ref, because updating state a hundred
    // times a second re-renders the answer for nothing. But a render can still
    // happen mid-drag — the next chunk of a streaming answer is exactly that — and
    // React would then write its own width over the dragged one. Reading the live
    // value here makes such a render agree with the edge instead of fighting it.
    userWidth: dragRef.current?.width ?? userWidth,
    availWidth: window.screen.availWidth
  })

  // Measure layout, not the entrance transform. getBoundingClientRect includes
  // the appear animation's scale, which used to feed false heights back to macOS.
  const resizeWindowToLayoutRef = useRef<() => void>(() => {})
  useLayoutEffect(() => {
    const node = rootNode
    if (!node) return
    let lastWidth = 0
    let lastHeight = 0
    const resizeWindowToLayout = (): void => {
      const width = node.offsetWidth
      const height = node.offsetHeight
      if (width === lastWidth && height === lastHeight) return
      lastWidth = width
      lastHeight = height
      // `pin` while a drag is in flight: the right edge is under the pointer, so
      // the card has to grow away from its left edge instead of from the anchor.
      window.deskhand.overlay.resize(height, width, draggingRef.current, typingRef.current)
    }
    const onFocus = (): void => {
      lastWidth = lastHeight = 0
      resizeWindowToLayout()
      inputRef.current?.focus()
    }
    resizeWindowToLayoutRef.current = resizeWindowToLayout
    const observer = new ResizeObserver(resizeWindowToLayout)
    observer.observe(node)
    resizeWindowToLayout()
    window.addEventListener('focus', onFocus)
    return () => {
      resizeWindowToLayoutRef.current = () => {}
      observer.disconnect()
      window.removeEventListener('focus', onFocus)
    }
  }, [rootNode])

  // Chromium sizes the field from its content. Report the final layout before
  // paint without temporarily collapsing the focused textarea to measure it.
  useLayoutEffect(() => {
    resizeWindowToLayoutRef.current()
  }, [prompt, cardWidth, wrapped, rootNode])

  useEffect(() => {
    const node = answerRef.current
    if (node) node.scrollTop = node.scrollHeight
  }, [answer])

  // A setup problem or a failed request is not a detail: the card unfolds, so
  // the reason (and the way out of it) is never hidden behind a chevron.
  useEffect(() => {
    if (failure || state?.setupNotice) setExpanded(true)
  }, [failure, state?.setupNotice])

  const send = useCallback((text: string, sendMode?: ResponseMode, spoken = false) => {
    const value = text.trim()
    const current = stateRef.current
    if (!value || !current) return
    if (busyRef.current) {
      // A typed Enter while an answer streams is most likely a duplicate; a
      // spoken command is a new question and has to win, or the phrase would be
      // swallowed and the user would hear nothing back at all.
      if (!spoken) return
      const previous = requestIdRef.current
      setBusy(false)
      if (previous) window.deskhand.overlay.cancel(previous)
    }
    const usedMode = sendMode ?? 'insert'
    const requestId = newRequestId()
    requestIdRef.current = requestId
    // What this turn is, for the speech gate at the end of it.
    turnKindRef.current = { spoken, action: looksLikeAction(value) }
    stoppedByUserRef.current = false
    speechRef.current.begin(requestId, value, spoken)
    setBusy(true)
    setAnswer('')
    setFailure(null)
    setNotice(null)
    // A new question is a new card: a width chosen while reading the previous
    // answer must not decide how wide this one opens.
    setUserWidth(null)
    // A plan from the previous turn is not a state of this one. Without this the
    // "Готово" row would sit under a fresh question until the new answer arrives.
    setAgent(null)
    // The question has been asked: whatever the user typed to ask it is no longer
    // "using the card", and the answer — drawings included — is what they will be
    // looking at now. Without this the card would stay solid for the whole
    // answer, because the field still holds the question.
    setTyping(false)
    // The field is emptied on send, not on answer.
    //
    // It used to keep the question so the user could see what was asked — but the
    // answer appears directly under the field, so the question is right there in
    // the reply anyway. What the leftover text actually did was make every
    // follow-up start from the previous question: «а почему?» had to be appended
    // to a paragraph that was already sent, and the field grew into a draft of
    // both questions at once. Clearing it here makes the next question a new
    // question — which is exactly what the conversation memory is for.
    //
    // A spoken phrase is the exception, and only for a moment: it is the sole
    // confirmation of what was heard, so it stays until the answer starts arriving
    // (`onStream` clears it then). The user did not type it, so they have not
    // already seen it.
    spokenPromptRef.current = spoken
    setPrompt(spoken ? value : '')
    setLast({ prompt: value, mode: usedMode, refine: null, base: '', spoken })
    window.deskhand.overlay.send({
      requestId,
      prompt: value,
      mode: usedMode,
      includeSelection: current.flags.includeSelection,
      includeScreenshot: current.flags.includeScreenshot,
      voice: spoken
    })
  }, [])

  /**
   * "Короче / длиннее" on an answer that is already on screen. The current text is
   * sent back as the base, so repeated taps keep tightening (or growing) the same
   * summary instead of re-asking the original question.
   */
  // Assigned after `send` is defined so the transcript listener can call it
  // without depending on it (that would resubscribe on every render).
  sendRef.current = (text: string, spoken?: boolean) => send(text, undefined, spoken)

  const refine = useCallback(
    (direction: RefineDirection, base?: string) => {
      const current = stateRef.current
      const baseAnswer = (base ?? answer).trim()
      if (!current || !baseAnswer || busyRef.current) return
      const requestId = newRequestId()
      requestIdRef.current = requestId
      speechRef.current.stop()
      replaceOnChunkRef.current = !base
      setBusy(true)
      setFailure(null)
      setNotice(null)
      setLast({
        prompt: last?.prompt ?? '',
        mode: last?.mode ?? 'insert',
        refine: direction,
        base: baseAnswer,
        spoken: false
      })
      window.deskhand.overlay.send({
        requestId,
        prompt: last?.prompt ?? '',
        mode: last?.mode ?? 'insert',
        includeSelection: current.flags.includeSelection,
        includeScreenshot: current.flags.includeScreenshot,
        refine: { direction, baseAnswer }
      })
    },
    [answer, last]
  )

  /**
   * The screenshot tag also arms the drawing tool: with an image the assistant
   * can circle and point, without one it has nothing to aim at. That is the whole
   * difference — there is no separate "drawing mode" to switch on.
   */
  const toggleFlag = useCallback((key: 'includeSelection' | 'includeScreenshot') => {
    const current = stateRef.current
    if (!current) return
    const flags = { ...current.flags, [key]: !current.flags[key] }
    setState({ ...current, flags })
    window.deskhand.overlay.setFlags(flags)
  }, [])

  const clearDrawing = useCallback(() => {
    window.deskhand.overlay.clearDrawing()
  }, [])

  /**
   * Persists the master switch without leaving the card.
   *
   * The mode is off by default and stays off until someone flips a switch in a
   * different window — which is why the assistant used to answer "открой вкладку"
   * by drawing on the tab button: it could see the screen but was not allowed to
   * touch it, and nothing on screen said so. The result is applied from the answer
   * rather than assumed: turning it on usually leaves Accessibility still missing,
   * and the card has to show that next step instead of pretending all is well.
   */
  const setAgentEnabled = useCallback(async (enabled: boolean) => {
    const next = await window.deskhand.agent.setEnabled(enabled)
    setState((prev) => (prev ? { ...prev, agent: next } : prev))
    if (!enabled) {
      setNotice(null)
      return
    }
    // Switching it on does not make it able to press: on a fresh machine
    // Accessibility is still missing. Unfolding the card is enough there — the
    // reason already arrives as `hint` and the grant has its own button — but the
    // user has to be looking at the card to see either.
    setExpanded(true)
    if (next.ready) {
      // The answer on screen was produced while acting was impossible, so it
      // cannot retroactively become an action. Saying that out loud is the
      // difference between "включил и ничего не изменилось" and a user who
      // presses «Повторить».
      setNotice('Управление включено. Повтори просьбу — теперь я её выполню.')
    }
  }, [])

  /**
   * Sends the user's decision about one call back to the run.
   *
   * The id comes from the question that is on screen, so a click that arrives
   * after the run moved on — a double press, a button that was already handled —
   * is dropped by the main process instead of being applied to the next question.
   * Nothing is cleared optimistically here: the row keeps showing the question
   * until the run itself says what happened, which is what keeps the card and the
   * machine from disagreeing for a frame.
   */
  const answerAgent = useCallback(
    async (request: AgentToolRequest, allow: boolean, remember: boolean) => {
      // A refusal ends the run; the run's own «Остановлено» would repeat the
      // decision the voice is about to name.
      if (!allow) stoppedByUserRef.current = true
      await window.deskhand.agent.answer(request.id, allow, remember)
      // The decision is the user's, so the line confirms it rather than the
      // agent's judgement — and the click that made it is already on the card.
      speechRef.current.say(
        allow ? (remember ? 'remembered' : 'approved') : 'denied',
        turnKindRef.current
      )
    },
    []
  )

  /** Speech that has already been recognised and put into this card. */
  useEffect(() => {
    const off = window.deskhand.voice.onTranscript(({ text, send: autoSend }) => {
      // A new phrase replaces whatever the previous turn left on the card. The
      // answer belongs to the question that produced it; keeping it under a fresh
      // transcript is how an old answer appeared to "answer" the new phrase.
      setAnswer('')
      setFailure(null)
      setNotice(null)
      setAgent(null)
      setPrompt(text)
      // A dictated draft is text the user will read and edit in the card, so it
      // counts as engaging with it — same as a keystroke.
      setTyping(true)
      // `autoSend` is the Clicky behaviour: speak a command, get the answer. The
      // prompt is set first so the user sees what was heard even while it runs.
      // `voice` tells the main process to keep the model's narration off the card
      // when the phrase turns out to be an action.
      pendingAutoSendRef.current = null
      if (autoSend && text) {
        if (stateRef.current) sendRef.current(text, true)
        else pendingAutoSendRef.current = text
      }
    })
    return off
  }, [])

  const paste = useCallback(async () => {
    const text = answerTextRef.current
    if (!text.trim()) return
    const sessionId = stateRef.current?.sessionId
    const result = await window.deskhand.overlay.paste(text)
    // The card can be closed (or replaced) while the paste is still waiting for
    // the target app. A notice about the previous card must not land in the next
    // one — or in a card the user already dismissed.
    if (stateRef.current?.sessionId !== sessionId) return
    if (!result.ok && result.message) setNotice(result.message)
  }, [])

  const copy = useCallback(async () => {
    const text = answerTextRef.current
    if (!text.trim()) return
    await window.deskhand.overlay.copy(text)
    if (copiedTimerRef.current !== null) window.clearTimeout(copiedTimerRef.current)
    setCopied(true)
    copiedTimerRef.current = window.setTimeout(() => {
      copiedTimerRef.current = null
      setCopied(false)
    }, 1500)
  }, [])

  /**
   * The width the content itself wants, and the one «Шире» opens to.
   *
   * `null` means the content already fits the card: there is nothing to widen,
   * so the button is not shown. `userWidth` set means the person has taken the
   * width over, and «Вернуть» gives it back to the content.
   */
  const wanted = expandedWidth(naturalWidth, window.screen.availWidth)

  const toggleWidth = useCallback(() => {
    setUserWidth(userWidth === null ? wanted : null)
  }, [userWidth, wanted])

  /**
   * Dragging the card's right edge.
   *
   * Three things make this feel like an edge and not like a slider:
   *
   * - The delta comes from the pointer's *screen* position, not from its position
   *   inside the window. The window moves and resizes while the drag runs, so a
   *   client-space delta would fold the card's own motion back into the pointer
   *   and the edge would slide away from the hand pulling it.
   * - The width is written straight onto the element and never through React.
   *   A state update per pointer move re-renders the whole card — the answer's
   *   Markdown included — a hundred times a second, and the card lags behind the
   *   hand by exactly that much. State is committed once, on release.
   * - The window follows from the element: the `ResizeObserver` in
   *   `resizeWindowToLayout` sees the new width and resizes the window with
   *   `pin`, so the left edge stays put and the right edge tracks the pointer.
   *   There is one resize path, not two.
   */
  const gripDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return
      const node = rootNode
      if (!node) return
      event.preventDefault()
      event.currentTarget.setPointerCapture(event.pointerId)
      dragRef.current = { startX: event.screenX, startWidth: node.offsetWidth, width: node.offsetWidth }
      draggingRef.current = true
      setDragging(true)
    },
    [rootNode]
  )

  const gripMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    const node = rootNode
    if (!drag || !node) return
    // The drawer's buttons need the full width, so an unfolded card cannot be
    // dragged narrower than that: it would snap back on release.
    const floor = wantsWide ? CARD_WIDTH : undefined
    const width = draggedWidth(
      drag.startWidth,
      event.screenX - drag.startX,
      window.screen.availWidth,
      floor
    )
    if (width === drag.width) return
    drag.width = width
    node.style.width = `${width}px`
  }, [rootNode, wantsWide])

  const gripUp = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag) return
    dragRef.current = null
    draggingRef.current = false
    setDragging(false)
    // One commit for the whole gesture. Until this render the element carries the
    // dragged width imperatively, so React writing the same number changes
    // nothing on screen.
    setUserWidth(drag.width)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }, [])

  const closeCard = useCallback(() => {
    speechRef.current.stop()
    window.deskhand.overlay.close()
  }, [])

  /**
   * Stops the answer in flight and gives the question back.
   *
   * The order matters: the request is marked ignored *before* it is cancelled, so
   * a chunk already on its way cannot land on a card that has stopped waiting for
   * it. The field is only refilled when the user has not started a follow-up in
   * it — stopping an answer must not overwrite the next question.
   */
  const cancelRequest = useCallback(() => {
    speechRef.current.stop()
    const id = requestIdRef.current
    if (!id) return
    ignoredRequestRef.current = id
    requestIdRef.current = null
    busyRef.current = false
    setBusy(false)
    setFailure(null)
    setNotice(null)
    spokenPromptRef.current = false
    const question = last?.prompt ?? ''
    if (question && !promptRef.current.trim()) {
      setPrompt(question)
      promptRef.current = question
      setTyping(true)
    }
    inputRef.current?.focus()
    window.deskhand.overlay.cancel(id)
  }, [last])

  /**
   * Performs what `keyPolicy` decided.
   *
   * The decision is a pure function of the key and the card's state; the effects
   * need the live component, so they stay here.
   */
  const perform = useCallback(
    (action: Exclude<KeyAction, null>) => {
      if (action === 'close') {
        closeCard()
        return
      }
      if (action === 'stopAgent') {
        speechRef.current.stop()
        // The user ended this one, so the voice does not report it back to them.
        stoppedByUserRef.current = true
        void window.deskhand.agent.stop()
        return
      }
      if (action === 'cancel') {
        cancelRequest()
        return
      }
      if (action === 'approve' || action === 'approveAlways' || action === 'deny') {
        const request = agentRef.current?.approval
        // The native watcher answers an Escape that arrives with no question
        // left; doing it here as well would stop a run the user only refused.
        if (request) void answerAgent(request, action !== 'deny', action === 'approveAlways')
        return
      }
      if (action === 'paste') {
        void paste()
        return
      }
      if (action === 'copy') {
        void copy()
        return
      }
      send(promptRef.current)
    },
    [answerAgent, cancelRequest, closeCard, copy, paste, send]
  )

  useEffect(() => {
    const handler = (event: KeyboardEvent): void => {
      const action = keyPolicy({
        key: event.key,
        meta: event.metaKey || event.ctrlKey,
        shift: event.shiftKey,
        tagName: (event.target as HTMLElement | null)?.tagName ?? null,
        agentPhase: agentRef.current?.phase ?? null,
        busy: busyRef.current,
        runActive: Boolean(agentRef.current) && busyRef.current,
        hasSelection: Boolean(window.getSelection()?.toString()),
        hasAnswer: Boolean(answerTextRef.current.trim())
      })
      if (!action) return
      // ⌘C without a selection is ours; with one, `keyPolicy` has already said
      // `null` and the browser keeps the default copy.
      event.preventDefault()
      perform(action)
    }

    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [perform])

  // Nothing at all until the renderer knows whether a turn is running — see
  // `ready` in `useVoice`.
  if (!voice.ready) return null

  /**
   * A voice turn is not a card: there is no glass, no field, no padding — just the
   * bars, hanging where the input field would be. This is rendered before the card
   * on purpose. The turn starts while the context is still being collected, and
   * the bars are the only thing that should be on screen then.
   */
  if (listening) {
    return (
      <div ref={rootRef} className="card" style={{ width: cardWidth }} data-voice>
        <div
          className="voice"
          data-phase={voice.phase}
          style={{ '--amp': amp.toFixed(3) } as CSSProperties}
          role="status"
          aria-label={voice.phase === 'listening' ? 'Слушаю' : 'Распознаю'}
        >
          {Array.from({ length: VOICE_BARS }, (_, bar) => (
            <i key={bar} />
          ))}
        </div>
      </div>
    )
  }

  /**
   * Everything the card decides about itself, in one place and out of this file.
   *
   * The flags are a pure function of the session, the drawer and the last request
   * — see `viewFlags.ts`. They used to be expressions here, which meant they could
   * only be checked by looking at the card. `blocked` is one of them: the field
   * needs it before the session exists, and the drawer's lines need it after.
   */
  const {
    blocked,
    showMeta,
    answerReady,
    agentOff,
    agentBlocked,
    promptLooksLikeAction,
    hint,
    needsAttention
  } = deriveView({
    session: state,
    expanded,
    hasAnswer,
    busy,
    failed: Boolean(failure),
    last
  })
  const showingTranscript = busy && last?.spoken && Boolean(prompt)

  /**
   * The field is shared by the provisional and ready card.
   *
   * Held as an expression because the card renders it in two states — while the
   * context is still being collected, and once the session is there with the
   * chevron and the stop button beside it.
   */
  const composer = (
    <textarea
      ref={fieldRef}
      className="prompt"
      rows={1}
      spellCheck
      placeholder="Что сделать?"
      aria-label="Что сделать?"
      data-wrap={wrapped || undefined}
      value={prompt}
      disabled={blocked}
      readOnly={showingTranscript}
      onChange={(event) => {
        setPrompt(event.target.value)
        setTyping(true)
      }}
      onBlur={() => setTyping(false)}
      /*
        The field's own Enter, kept separate from the window handler on purpose
        (A1.7). Both ask `keyPolicy` — the same decision — but they are two call
        sites because the textarea sees the keystroke first and swallows it: the
        window handler is the fallback for Enter pressed anywhere else. Merging
        them would change which element consumes the key.
      */
      onKeyDown={(event) => {
        if (keyPolicy({
          key: event.key,
          meta: event.metaKey || event.ctrlKey,
          shift: event.shiftKey,
          tagName: 'TEXTAREA',
          agentPhase: null,
          busy: busyRef.current,
          runActive: false,
          hasSelection: false,
          hasAnswer: Boolean(answer.trim())
        }) !== 'send') {
          return
        }
        event.preventDefault()
        send(prompt)
      }}
    />
  )

  /**
   * The card is on screen *before* its session exists.
   *
   * The window comes up on the key press, and the context — frontmost app,
   * selection, screenshot — lands a few hundred milliseconds later. That gap is
   * rendered as the card itself: the same field and the same placeholder.
   * Announcing the wait ("Подготовка контекста…") turned the first beat of every
   * press into a status line nobody asked to read, and made the panel change shape
   * and contents right after it appeared. Collecting the context is background
   * work; the card just looks like itself from frame one.
   */
  if (!state) {
    // Nothing to unfold yet and nothing to send to: the field is the whole card.
    //
    // It is still a real field, and what is typed into it survives the handoff —
    // `reset` keeps the text when the session lands, so a fast typist never loses
    // the beginning of the question to the context collection finishing. Enter
    // before the session exists is a no-op rather than an error: `send` returns
    // without touching the text, and the same Enter works a moment later.
    return (
      <div ref={rootRef} className="card" style={{ width: cardWidth }}>
        <div className="move" aria-hidden />
        <div className="bar">
          {composer}
          {/*
            The chevron's place, held empty.

            The width the field is measured against already counts a chevron
            (`CHROME_WIDTH`), and the card must not change size when the session
            lands: without a claim on those 22 points the field would take them,
            and the chevron arriving a moment later would push the text 22 points
            to the left — a jump in the middle of the first sentence typed.
          */}
          <span className="reserve" aria-hidden />
          <button className="close" title="Закрыть" aria-label="Закрыть" onClick={closeCard}>
            <svg viewBox="0 0 10 10" aria-hidden>
              <path d="M2 2l6 6M8 2l-6 6" />
            </svg>
          </button>
        </div>
      </div>
    )
  }

  const { context, flags, setupNotice } = state
  const selection = context.selection
  const screenshot = context.screenshot
  /** The call the run is waiting on an answer for, if any. */
  const approval = agent?.approval ?? null

  return (
    // While the assistant is painting on the screen the card turns into a much
    // thinner sheet of glass: the arrow exists to point at something *behind*
    // the card, and an opaque panel sitting on that very spot is what hides it.
    <div
      ref={rootRef}
      className="card"
      style={{ width: cardWidth }}
      data-busy={busy || undefined}
      data-drawing={(drawn > 0 && !typing) || undefined}
    >
      <div className="move" aria-hidden />
      {!agentRunning && showingTranscript && <div className="line">Распознано</div>}
      {!agentRunning && (
        <div className="bar">
          {composer}
          {busy && (
            <button
              className="stop"
              title="Остановить ответ"
              onClick={cancelRequest}
            >
              <span aria-hidden />
            </button>
          )}
          <button
            className="toggle"
            data-open={expanded || undefined}
            data-alert={!expanded && needsAttention ? true : undefined}
            aria-expanded={expanded}
            aria-label={expanded ? 'Свернуть' : 'Развернуть'}
            title={expanded ? 'Свернуть' : 'Контекст, подсказки и действия'}
            onClick={() => setExpanded((value) => !value)}
          >
            <svg viewBox="0 0 10 6" aria-hidden>
              <path d="M1 1l4 4 4-4" />
            </svg>
          </button>
          <button className="close" title="Закрыть" aria-label="Закрыть" onClick={closeCard}>
            <svg viewBox="0 0 10 10" aria-hidden>
              <path d="M2 2l6 6M8 2l-6 6" />
            </svg>
          </button>
        </div>
      )}

      {/* The turn is the bars above; only a failure is worth a line here. A
          successful transcript is already in the field (and the answer replaces
          it), so repeating it under the field reads as a second answer. */}
      {voice.phase === 'idle' && voice.error && voice.message && (
        <div className="line" data-tone="err">
          {voice.message}
        </div>
      )}

      {showMeta && !agentRunning && (
        <div className="drawer">
          <div className="meta">
            <span className="app" title={context.activeApp?.bundleId ?? ''}>
              {context.activeApp?.name ?? 'Без приложения'}
            </span>
            <button
              className="tag"
              data-on={flags.includeSelection && Boolean(selection)}
              disabled={!selection}
              onClick={() => toggleFlag('includeSelection')}
              title={
                selection
                  ? `Использовать выделенный текст: ${selection.text.slice(0, 200)}`
                  : 'Выделенный текст не найден'
              }
            >
              {selection ? `Текст · ${selection.text.length}` : 'Текст'}
            </button>
            <button
              className="tag"
              data-on={flags.includeScreenshot && Boolean(screenshot)}
              disabled={!screenshot}
              onClick={() => toggleFlag('includeScreenshot')}
              title={
                screenshot
                  ? 'Ассистент видит экран — и сам решит, когда обвести элемент или показать стрелкой'
                  : 'Скриншот недоступен'
              }
            >
              {context.screenshotPending ? 'Экран…' : 'Экран'}
            </button>
            {screenshot && flags.includeScreenshot && <LiveThumb src={screenshot.dataUrl} />}
            {drawn > 0 && (
              <button
                className="tag clear"
                onClick={clearDrawing}
                title="Убрать рисунок с экрана"
              >
                Рисунок {drawn} ×
              </button>
            )}
          </div>
        </div>
      )}

      {expanded && blocked && (
        <div className="line" data-tone="warn">
          Приложение в исключениях — ничего не отправляется.
        </div>
      )}

      {expanded && setupNotice && (
        <div className="line" data-tone={setupNotice.kind === 'error' ? 'err' : 'warn'}>
          <span>{setupNotice.message}</span>
          <button className="tag" onClick={() => window.deskhand.settings.open()}>
            Настройки
          </button>
        </div>
      )}

      {expanded && hint && !blocked && <div className="line">{hint}</div>}

      {/*
        An offer, not a complaint: the mode is off, so the assistant can only
        show. It appears when the card has content, when shapes were drawn, and
        when the request itself was an action — "нарисовал вместо того, чтобы
        сделать" is exactly the moment this switch is worth knowing about, and
        inside the drawer it would only be found by people who already knew.
      */}
      {agentOff && !blocked && !busy && (expanded || drawn > 0 || promptLooksLikeAction) && (
        <div className="line" data-tone={promptLooksLikeAction ? 'warn' : undefined}>
          <span>
            {promptLooksLikeAction
              ? 'Это можно было сделать, а не показать: включи управление — и я нажму сам.'
              : 'Могу и нажать за тебя — управление мышью пока выключено.'}
          </span>
          <button className="tag" onClick={() => void setAgentEnabled(true)}>
            Включить
          </button>
        </div>
      )}

      {/*
        Enabled but still blocked (almost always the Accessibility grant). The
        reason already arrived through `hint`; this adds the way out of it, since
        "нужен доступ" without a button is a dead end in a card this small.
      */}
      {expanded && agentBlocked && !blocked && !busy && (
        <div className="line">
          <button
            className="tag"
            onClick={() => window.deskhand.permissions.open('accessibility')}
          >
            Открыть «Универсальный доступ»
          </button>
        </div>
      )}

      {agentDone ? (
        <div className="agent-head agent-done" role="status">
          <svg className="agent-check" viewBox="0 0 20 20" aria-hidden="true">
            <path d="m3 10 4.5 4.5 9-9" />
          </svg>
          <span className="agent-label">Готово</span>
        </div>
      ) : agent && (agentStatus || approval) ? (
        <div
          className="agent"
          data-phase={agent.phase}
          data-mark={agentMark(agent)}
          data-running={agentRunning || undefined}
        >
          {agentStatus && (
            <div className="agent-head" role="status">
              <span className="agent-dot" aria-hidden />
              <span className="agent-label" key={`${agent.step}:${agent.phase}`}>{agentStatus}</span>
              {agentHint && <span className="agent-hint">{agentHint}</span>}
            </div>
          )}

          {/*
            The confirmation, in the flow of the run rather than in a modal.
            The question is about one named element — "нажать «Экспорт» в Safari" —
            and a system dialog would cover the window it is asking about. Here it
            appears where the step it belongs to appears, so the user reads the
            run and the question as one thing.
          */}
          {agent.phase === 'asking' && approval && (
            <div className="agent-ask" role="group" aria-label="Подтверждение действия">
              <div className="agent-ask-title">Нужно разрешение</div>
              {agent.message && <div className="agent-ask-detail">{agent.message}</div>}
              <div className="agent-ask-buttons">
                <button
                  className="agent-allow"
                  onClick={() => void answerAgent(approval, true, false)}
                >
                  Разрешить
                </button>
                <button
                  className="agent-always"
                  title="Запомнить именно это действие и больше не спрашивать"
                  onClick={() => void answerAgent(approval, true, true)}
                >
                  Больше не спрашивать
                </button>
                <button
                  className="agent-deny"
                  onClick={() => void answerAgent(approval, false, false)}
                >
                  Отменить
                </button>
              </div>
              <div className="agent-ask-hint">↩ разрешить · ⌘↩ больше не спрашивать · Esc отменить</div>
            </div>
          )}
        </div>
      ) : null}

      {showWaiting && (
        <div className="waiting" role="status" aria-live="polite">
          <div className="waiting-label">Готовлю ответ…</div>
          {waitStage === 'long' ? (
            <div>Ответ занимает больше времени. Esc — остановить ответ.</div>
          ) : waitStage === 'tip' ? (
            <div><span className="waiting-caption">На заметку</span>{waiting.tip}</div>
          ) : null}
        </div>
      )}

      {failure && (
        <>
          {last?.spoken && <div className="line transcript">Распознано: {last.prompt}</div>}
          <div className="line" data-tone="err">
            <span>{failure.message}</span>
            {failure.retryable && last && (
              <button
                className="tag"
                onClick={() =>
                  last.refine
                    ? refine(last.refine, last.base)
                    : send(last.prompt, last.mode, last.spoken)
                }
              >
                Повторить
              </button>
            )}
          </div>
        </>
      )}

      {/*
        Only real text earns an answer row. An empty "thinking" box under the
        field is what made a voice action look like it had answered something.
      */}
      {hasAnswer && (
        <div ref={answerRef} className="answer">
          <Markdown text={answer} streaming={busy} caret={busy} />
        </div>
      )}

      {/*
        The everyday actions, on one row; rewrites live in the drawer.

        Pasting is not here. It is the one action that takes the card away from
        you — it activates another app, sends a keystroke and comes back — and
        behind a button in the corner it fired by accident. ⌘⏎ is the same
        action, reached on purpose.
      */}
      {hasAnswer && (!busy || speech.speaking) && (
        <div className="foot answer-actions">
          <button className="link" onClick={() => speech.speaking ? speech.stop() : speech.speak(answer)}>
            {speech.speaking ? 'Остановить озвучку' : 'Прослушать'}
          </button>
          {answerReady && (
            <>
              <span className="spacer" />
              {/*
                The one-click half of the drag. It is in the action row rather
                than behind the chevron because the moment you notice a table is
                cramped is the moment you are looking at it.

                Only shown when the content is actually wider than the card: a
                «Шире» that widens a two-word answer is a button that does
                nothing, and a person who presses it once and sees no change
                stops trusting the edge.
              */}
              {userWidth !== null && (
                <button className="link" title="Вернуть ширину по содержимому" onClick={toggleWidth}>
                  Вернуть
                </button>
              )}
              {userWidth === null && wanted !== null && (
                <button className="link" title="Развернуть по содержимому" onClick={toggleWidth}>
                  Шире
                </button>
              )}
              <button
                className="link"
                data-copied={copied || undefined}
                title={copied ? 'Скопировано в буфер обмена' : 'Скопировать ответ'}
                onClick={() => void copy()}
              >
                {copied ? 'Скопировано' : 'Скопировать'}
              </button>
            </>
          )}
        </div>
      )}
      {speech.error && <div className="line" role="status">{speech.error}</div>}

      {hasAnswer && expanded && (
        <div className="foot">
          {!busy && (
            <>
              {(Object.keys(REFINE_LABEL) as RefineDirection[]).map((direction) => (
                <button
                  key={direction}
                  className="link"
                  title={REFINE_HINT[direction]}
                  onClick={() => refine(direction)}
                >
                  {REFINE_LABEL[direction]}
                </button>
              ))}
            </>
          )}
        </div>
      )}

      {notice && <div className="line">{notice}</div>}

      {/*
        The resize edge. It sits on the card's outermost right column, over the
        card's padding and outside the answer's scrollbar, so pulling it never
        fights a scroll gesture or a text selection.
      */}
      {hasAnswer && (
        <div
          className="grip"
          role="separator"
          aria-orientation="vertical"
          aria-label="Изменить ширину"
          data-dragging={dragging || undefined}
          onPointerDown={gripDown}
          onPointerMove={gripMove}
          onPointerUp={gripUp}
          onPointerCancel={gripUp}
        />
      )}
    </div>
  )
}
