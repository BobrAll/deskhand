/**
 * The overlay UI (ТЗ §8).
 *
 * A bubble, not a window: one line for the question, the answer printed directly
 * underneath it. It appears next to the cursor (the main process owns the
 * placement) as *only* that line plus one small chevron; context tags, quick
 * actions and the answer's secondary commands stay folded behind the chevron, so
 * the common case — ask, read, paste — is a small rectangle that never covers the
 * screen.
 *
 * Keyboard: Enter sends, Cmd/Ctrl+Enter pastes, Esc closes, Cmd/Ctrl+C copies the
 * answer when nothing is selected.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import type {
  AgentEvent,
  ContextSnapshot,
  OverlayState,
  RefineDirection,
  ResponseMode,
  StreamEvent
} from '@shared/types'
import {
  CARET_SLACK,
  CHROME_WIDTH,
  FIELD_FONT,
  FULL_WIDTH,
  MAX_FIELD_HEIGHT,
  NARROW_WIDTH,
  REFINE_HINT,
  REFINE_LABEL,
  STOP_CHROME,
  VOICE_WIDTH,
  clamp
} from './metrics'
import { useVoice } from './useVoice'
import { deriveView } from './viewFlags'

interface Failure {
  message: string
  retryable: boolean
}

function newRequestId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/**
 * The width of the widest line of `text`, in the font the field renders in.
 *
 * Measured, never guessed from the character count: «ш» and «i» are not the same
 * letter, and a bubble that widens by a different step than the typing does reads
 * as a glitch rather than as the card making room. A canvas 2D context is the
 * cheapest shaper that agrees with the textarea — no extra element whose layout
 * could lag the keystroke being measured.
 */
function measureLine(text: string, font: string): number {
  if (!text) return 0
  if (!ruler) ruler = document.createElement('canvas').getContext('2d')
  if (!ruler) return 0
  if (ruler.font !== font) ruler.font = font
  let widest = 0
  // Only an explicit newline is another row; a soft wrap is a consequence of the
  // width this measurement is about to decide and must not feed back into it.
  for (const line of text.split('\n')) {
    widest = Math.max(widest, ruler.measureText(line).width)
  }
  return widest
}

/** One measuring context for the whole window: creating one is not free. */
let ruler: CanvasRenderingContext2D | null = null

/**
 * The context tag re-captures its image live, so the `src` changes every couple
 * of seconds. Swapping it straight onto an `<img>` blanks the thumbnail for a
 * frame each time (the new data URL is decoded after the old one is dropped), so
 * the next frame is preloaded and only then takes over.
 */
function LiveThumb({ src }: { src: string }) {
  const [shown, setShown] = useState(src)
  const [incoming, setIncoming] = useState<string | null>(null)

  useEffect(() => {
    if (src === shown) {
      setIncoming(null)
      return
    }
    let cancelled = false
    const loader = new Image()
    loader.decoding = 'sync'
    loader.onload = () => {
      if (cancelled) return
      setShown(src)
      setIncoming(null)
    }
    loader.onerror = () => {
      if (!cancelled) setIncoming(null)
    }
    loader.src = src
    setIncoming(src)
    return () => {
      cancelled = true
    }
  }, [src, shown])

  return (
    <>
      <img className="thumb" src={shown} alt="Скриншот экрана" decoding="sync" />
      {incoming && <img className="thumb probe" src={incoming} alt="" aria-hidden />}
    </>
  )
}

export function App() {
  const [state, setState] = useState<OverlayState | null>(null)
  const [prompt, setPrompt] = useState('')
  const [mode, setMode] = useState<ResponseMode>('insert')
  const [answer, setAnswer] = useState('')
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<Failure | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
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
  /**
   * The bubble opens as a single small field. Everything else — context tags,
   * suggestions, status rows and the answer's action strip — lives behind the
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
    voice: boolean
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
  const busyRef = useRef(false)
  const modeRef = useRef<ResponseMode>('insert')
  const requestIdRef = useRef<string | null>(null)
  /**
   * A request that was abandoned when a voice turn started.
   *
   * Its late chunks must not land in the card after the transcript cleared it:
   * the question they answer is no longer the question on screen.
   */
  const ignoredRequestRef = useRef<string | null>(null)
  /** Latest `send`, so the voice listener does not resubscribe on every render. */
  const sendRef = useRef<(text: string, voice?: boolean) => void>(() => {})
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
    const style = window.getComputedStyle(node)
    fontRef.current =
      style.font || `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`
  }, [])
  /**
   * The bubble's outermost element, as state rather than a ref.
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
  busyRef.current = busy
  modeRef.current = mode
  agentRef.current = agent

  /**
   * Applies a state broadcast. A *new* session replaces the bubble completely; the
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
      sessionIdRef.current = next.sessionId
      // Imperative readers (`send`) must see the new session immediately: a queued
      // transcript can be sent before React has re-rendered.
      stateRef.current = next
      setState(next)
      if (!typedWhileEmpty) setPrompt('')
      setAnswer('')
      setFailure(null)
      setNotice(null)
      setBusy(false)
      setDrawn(0)
      setTyping(typedWhileEmpty)
      setExpanded(false)
      requestIdRef.current = null
      replaceOnChunkRef.current = false
      setAgent(null)
      window.setTimeout(() => inputRef.current?.focus(), 30)
      resumePendingSend()
    },
    [resumePendingSend]
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
   * Reacts to stream events. `done` is the authoritative final text; a rewrite in
   * flight keeps the previous answer visible until the first chunk arrives.
   */
  const onStream = useCallback((event: StreamEvent) => {
    if (event.requestId === ignoredRequestRef.current) return
    if (requestIdRef.current && event.requestId !== requestIdRef.current) return
    if (event.type === 'chunk') {
      // The first words of the answer are on screen, so the spoken phrase has done
      // its job: it was there to confirm what was heard while the model thought,
      // and leaving it in the field from then on is the leftover question that
      // every follow-up had to be appended to.
      if (spokenPromptRef.current) {
        spokenPromptRef.current = false
        setPrompt('')
      }
      if (replaceOnChunkRef.current) {
        replaceOnChunkRef.current = false
        setAnswer(event.delta)
      } else {
        setAnswer((prev) => prev + event.delta)
      }
      return
    }
    // An answer that never streamed (an action with no prose, a failure) leaves
    // the phrase behind too: the card has stopped working on it either way.
    if (spokenPromptRef.current) {
      spokenPromptRef.current = false
      setPrompt('')
    }
    requestIdRef.current = null
    replaceOnChunkRef.current = false
    setBusy(false)
    if (event.type === 'done') {
      setAnswer(event.text)
    } else {
      setFailure({ message: event.message, retryable: event.retryable })
    }
  }, [])

  useEffect(() => {
    // No session yet means the card is the empty one drawn while the context is
    // being collected — and it must *not* take the keyboard here. Focusing the
    // field would make this window the frontmost app, and `collectContext` reads
    // the frontmost app: the target would come back as the assistant itself. The
    // focus is taken in `reset`, once the session it belongs to exists.
    void window.smartCursor.overlay.getState().then((next) => {
      if (next) applyState(next)
    })

    const offState = window.smartCursor.overlay.onState(applyState)
    const offPreparing = window.smartCursor.overlay.onPreparing(() => {
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
      setAnswer('')
      setFailure(null)
      setNotice(null)
      setBusy(false)
      setAgent(null)
      setDrawn(0)
      setTyping(false)
      setExpanded(false)
      requestIdRef.current = null
      replaceOnChunkRef.current = false
      spokenPromptRef.current = false
    })
    const offContext = window.smartCursor.overlay.onContextUpdate((snapshot: ContextSnapshot) => {
      setState((prev) => (prev ? { ...prev, context: snapshot } : prev))
    })
    const offStream = window.smartCursor.overlay.onStream(onStream)
    const offAnnotations = window.smartCursor.overlay.onAnnotations((event) => {
      setDrawn(event.count)
    })
    const offAgent = window.smartCursor.agent.onEvent((event) => {
      setAgent(event.phase === 'idle' ? null : event)
    })

    return () => {
      offState()
      offPreparing()
      offContext()
      offStream()
      offAnnotations()
      offAgent()
    }
  }, [applyState, onStream])

  /**
   * The native blur follows the same rule as the panel's own density: the main
   * process drops the window's vibrancy while shapes are up, so putting the card
   * back to full opacity on the first keystroke has to put the glass back too.
   */
  useEffect(() => {
    window.smartCursor.overlay.setTyping(typing)
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
    const id = requestIdRef.current
    if (!id) return
    ignoredRequestRef.current = id
    requestIdRef.current = null
    setBusy(false)
    setFailure(null)
    setAgent(null)
    window.smartCursor.overlay.cancel(id)
  }, [voice.phase])

  /**
   * While a turn runs the card *is* the indicator: the field is replaced by the
   * bars — same window, same place, no background. There is no second window at
   * the cursor: one surface, one animation.
   */
  const listening = voice.phase !== 'idle'
  /** The bars open with the voice; the meter arrives at ~10 Hz, hence the transition. */
  const amp = voice.phase === 'listening' ? 0.62 + voice.level * 0.55 : 1

  /**
   * Whether there is anything to read. A model that produced only whitespace has
   * not answered, and an empty answer box on a voice turn is exactly the "answer
   * shown when there was none" this is meant to avoid.
   */
  const hasAnswer = answer.trim().length > 0

  /**
   * How wide the text in the field actually is, in points.
   *
   * Measured, not estimated from the character count: «ш» and «i» are not the
   * same letter, and a card that widens by a different step than the typing does
   * reads as a glitch rather than as the bubble making room. The measuring canvas
   * uses the field's own computed font, so the run is shaped exactly as it will
   * be inside the textarea.
   */
  const textWidth = prompt ? measureLine(prompt, fontRef.current) : 0

  /**
   * How wide the card wants to be: a folded bubble is a one-line field, and 360
   * points of it would be mostly empty surface. Anything that puts content under
   * the field — an answer, the unfolded drawer, a failure, an agent run — earns
   * the full width.
   */
  const wantsWide = expanded || hasAnswer || Boolean(failure) || Boolean(agent)

  /**
   * Everything on the line that is not the question, in points.
   *
   * The bubble's padding and edge, the presence dot, both gaps and the chevron —
   * plus the stop button, which is on screen exactly while a request is running.
   */
  const chromeWidth = CHROME_WIDTH + (busy ? STOP_CHROME : 0)

  /**
   * The width the card needs for the question being written.
   *
   * Nothing is added for empty space: the field gets as many points as the
   * sentence takes, so every keystroke widens the bubble by exactly one glyph and
   * the card only starts wrapping once it has reached `FULL_WIDTH`. That is the
   * difference between a bubble that grows under your hands and one that snaps
   * open to a panel the moment you start typing — the latter is loud in precisely
   * the moment a person is still deciding whether they want to say anything.
   */
  const composedWidth = clamp(
    Math.ceil(textWidth) + chromeWidth + CARET_SLACK,
    NARROW_WIDTH,
    FULL_WIDTH
  )

  /**
   * Whether the question has grown past the room the card can give it.
   *
   * While there is still room the field must not soft-wrap: the window is resized
   * a frame after the keystroke that widened it, and a wrap landing inside that gap
   * would add a second row and drop it again — a one-frame height flicker on every
   * letter. A field that only scrolls to the right until the card is as wide as it
   * goes, and wraps after that, keeps both the height and the width monotonic.
   */
  const wrapped = textWidth + chromeWidth + CARET_SLACK > FULL_WIDTH

  /** The width of the card as it was last laid out, reported to the main process. */
  const widthRef = useRef(NARROW_WIDTH)

  /**
   * The width the card was last asked for, kept across a send.
   *
   * Sending empties the field, so the measured width drops to the resting pill for
   * the round-trip and then opens again with the first chunk of the answer. Holding
   * the width the question was typed at is what keeps the card from twitching in
   * the middle of every question.
   */
  const heldWidthRef = useRef(NARROW_WIDTH)
  if (!busy && prompt) heldWidthRef.current = composedWidth

  const cardWidth = listening
    ? VOICE_WIDTH
    : wantsWide
      ? FULL_WIDTH
      : // Kept while the answer is on its way, so the card neither collapses
        // after Enter nor jumps wider before there is anything to read.
        busy
        ? Math.max(heldWidthRef.current, composedWidth)
        : composedWidth
  widthRef.current = cardWidth

  // The window is sized by the main process; report the laid-out size instead of
  // guessing it here. `rootRef` sits on the bubble itself, so its margins — the
  // room the shadow draws into — have to be added back: the window has to be the
  // card *plus* that room, or the shadow (and the last row of an answer) would be
  // cut off by the edge of the window.
  const reportRef = useRef<() => void>(() => {})
  useEffect(() => {
    const node = rootNode
    if (!node) return
    const report = (): void => {
      const style = window.getComputedStyle(node)
      const height =
        node.getBoundingClientRect().height +
        (Number.parseFloat(style.marginTop) || 0) +
        (Number.parseFloat(style.marginBottom) || 0)
      window.smartCursor.overlay.resize(Math.ceil(height), widthRef.current)
    }
    reportRef.current = report
    const observer = new ResizeObserver(report)
    observer.observe(node)
    report()
    // The main process places the window with a guess before this renderer has
    // laid anything out, and it takes the keyboard a moment later — after the
    // context is collected, with whatever width it assumed. Reporting again when
    // the card is focused is what makes the window agree with the card in the one
    // case the observer cannot see: the DOM never changed size, but the window it
    // is being drawn into did.
    window.addEventListener('focus', report)
    return () => {
      observer.disconnect()
      window.removeEventListener('focus', report)
    }
    // The renderer draws nothing at all until `voice.ready`, so the first run of
    // this effect can see no node; it has to re-attach when one appears — and again
    // when the root itself is swapped (bars -> card).
  }, [rootNode])

  // Width is not a function of the content box (the card is as wide as the window
  // the main process gave it), so a state change has to ask for it explicitly.
  useEffect(() => {
    reportRef.current()
  }, [cardWidth])

  /**
   * One line while the question fits, more when it does not — capped, so a pasted
   * paragraph cannot turn the bubble into a window.
   *
   * Measured to the exact line height, with nothing added. Two spare points used to
   * be there "for the caret", and they were the one jump left in the card: the empty
   * field is 17 tall inside a 31 pt window, so the first keystroke grew the card by
   * those two points and then never moved again. The cap matches `max-height` in
   * `overlay.css`, which is what actually stops the field growing.
   */
  const autosize = useCallback(() => {
    const el = inputRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, MAX_FIELD_HEIGHT)}px`
  }, [])

  useEffect(() => {
    autosize()
  }, [prompt, cardWidth, autosize])

  useEffect(() => {
    const node = answerRef.current
    if (node) node.scrollTop = node.scrollHeight
  }, [answer])

  // A setup problem or a failed request is not a detail: the bubble unfolds, so
  // the reason (and the way out of it) is never hidden behind a chevron.
  useEffect(() => {
    if (failure || state?.setupNotice) setExpanded(true)
  }, [failure, state?.setupNotice])

  const send = useCallback((text: string, sendMode?: ResponseMode, voice = false) => {
    const value = text.trim()
    const current = stateRef.current
    if (!value || !current) return
    if (busyRef.current) {
      // A typed Enter while an answer streams is most likely a duplicate; a
      // spoken command is a new question and has to win, or the phrase would be
      // swallowed and the user would hear nothing back at all.
      if (!voice) return
      const previous = requestIdRef.current
      setBusy(false)
      if (previous) window.smartCursor.overlay.cancel(previous)
    }
    const usedMode = sendMode ?? modeRef.current
    const requestId = newRequestId()
    requestIdRef.current = requestId
    setBusy(true)
    setAnswer('')
    setFailure(null)
    setNotice(null)
    // A plan from the previous turn is not a state of this one. Without this the
    // "Готово" row would sit under a fresh question until the new answer arrives.
    setAgent(null)
    // The question has been asked: whatever the user typed to ask it is no longer
    // "using the card", and the answer — drawings included — is what they will be
    // looking at now. Without this the bubble would stay solid for the whole
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
    if (voice) spokenPromptRef.current = true
    else {
      spokenPromptRef.current = false
      setPrompt('')
    }
    setLast({ prompt: value, mode: usedMode, refine: null, base: '', voice })
    window.smartCursor.overlay.send({
      requestId,
      prompt: value,
      mode: usedMode,
      includeSelection: current.flags.includeSelection,
      includeScreenshot: current.flags.includeScreenshot,
      voice
    })
  }, [])

  /**
   * "Короче / длиннее" on an answer that is already on screen. The current text is
   * sent back as the base, so repeated taps keep tightening (or growing) the same
   * summary instead of re-asking the original question.
   */
  // Assigned after `send` is defined so the transcript listener can call it
  // without depending on it (that would resubscribe on every render).
  sendRef.current = (text: string, voice?: boolean) => send(text, undefined, voice)

  const refine = useCallback(
    (direction: RefineDirection, base?: string) => {
      const current = stateRef.current
      const baseAnswer = (base ?? answer).trim()
      if (!current || !baseAnswer || busyRef.current) return
      const requestId = newRequestId()
      requestIdRef.current = requestId
      replaceOnChunkRef.current = !base
      setBusy(true)
      setFailure(null)
      setNotice(null)
      setLast({
        prompt: last?.prompt ?? '',
        mode: last?.mode ?? modeRef.current,
        refine: direction,
        base: baseAnswer,
        voice: false
      })
      window.smartCursor.overlay.send({
        requestId,
        prompt: last?.prompt ?? '',
        mode: last?.mode ?? modeRef.current,
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
    window.smartCursor.overlay.setFlags(flags)
  }, [])

  const clearPointer = useCallback(() => {
    window.smartCursor.overlay.clearPointer()
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
    const next = await window.smartCursor.agent.setEnabled(enabled)
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
      setNotice('Управление включено. Повторите просьбу — теперь я её выполню.')
    }
  }, [])

  /** Speech that has already been recognised and put into this bubble. */
  useEffect(() => {
    const off = window.smartCursor.voice.onTranscript(({ text, send: autoSend }) => {
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
    if (!answer.trim()) return
    const result = await window.smartCursor.overlay.paste(answer)
    if (!result.ok && result.message) setNotice(result.message)
  }, [answer])

  const copy = useCallback(async () => {
    if (!answer.trim()) return
    await window.smartCursor.overlay.copy(answer)
    setNotice('Скопировано в буфер обмена')
  }, [answer])

  useEffect(() => {
    const handler = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        // While a plan runs, Escape is "стоп", not "закрыть": the card closing
        // would hide the very row that reports what was interrupted, and the
        // user pressing Escape is watching the screen, not the bubble.
        const phase = agentRef.current?.phase
        // `checking` belongs to the run as much as the plan does: the user is
        // waiting on a request they can still stop, and Escape closing the card
        // instead would hide the row that reports whether the thing worked. It
        // stops differently, though: during the check nothing is moving, so there
        // is no run to stop — the request in flight is what has to be cancelled.
        if (phase === 'checking') {
          const id = requestIdRef.current
          if (!id) {
            window.smartCursor.overlay.close()
            return
          }
          // Same shape as a spoken question interrupting an answer: the request is
          // marked ignored *before* it is cancelled, so a chunk already in flight
          // cannot land on a card that stopped waiting for it.
          ignoredRequestRef.current = id
          requestIdRef.current = null
          setBusy(false)
          // The row is set here rather than left to the answer: the main process
          // clears it on its own path, but a check cancelled inside the stream
          // produces neither a verdict nor a `done`, and a card stuck on
          // "проверяю" over nothing is the one thing this feature must never show.
          setAgent({
            phase: 'aborted',
            step: 0,
            total: 0,
            label: '',
            plan: [],
            message: 'Проверка остановлена.'
          })
          window.smartCursor.overlay.cancel(id)
          return
        }
        if (phase === 'arming' || phase === 'acting') {
          void window.smartCursor.agent.stop()
          return
        }
        window.smartCursor.overlay.close()
        return
      }

      const meta = event.metaKey || event.ctrlKey
      if (meta && event.key === 'Enter') {
        event.preventDefault()
        void paste()
        return
      }
      if (meta && event.key.toLowerCase() === 'c') {
        const selection = window.getSelection()?.toString() ?? ''
        if (!selection && answer.trim()) {
          event.preventDefault()
          void copy()
        }
        return
      }
      if (event.key === 'Enter' && !meta && !event.shiftKey) {
        const target = event.target as HTMLElement | null
        if (target?.tagName === 'TEXTAREA') {
          event.preventDefault()
          send(prompt)
        }
      }
    }

    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [answer, copy, paste, prompt, send])

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
      <div ref={rootRef} className="bubble" data-voice>
        <div
          className="voice"
          data-phase={voice.phase}
          style={{ '--amp': amp.toFixed(3) } as CSSProperties}
          role="status"
          aria-label={voice.phase === 'listening' ? 'Слушаю' : 'Распознаю'}
        >
          {[0, 1, 2, 3, 4].map((bar) => (
            <i key={bar} />
          ))}
        </div>
      </div>
    )
  }

  /**
   * The card is on screen *before* its session exists.
   *
   * The window comes up on the key press, and the context — frontmost app,
   * selection, screenshot — lands a few hundred milliseconds later. That gap is
   * rendered as the card itself: the same spark, the same field, the same
   * placeholder. Announcing the wait ("Подготовка контекста…") turned the first
   * beat of every press into a status line nobody asked to read, and made the
   * panel change shape and contents right after it appeared. Collecting the
   * context is background work; the card just looks like itself from frame one.
   */
  const blocked = state?.context.excluded ?? false

  /**
   * The one line the bubble is: the presence dot and the field.
   *
   * Held as an expression because the card renders it in two states — while the
   * context is still being collected, and once the session is there with the
   * chevron and the stop button beside it.
   */
  const composer = (
    <>
      <span className="spark" data-live={busy} aria-hidden />
      <textarea
        ref={fieldRef}
        className="prompt"
        rows={1}
        spellCheck
        placeholder="Пиши…"
        data-wrap={wrapped || undefined}
        value={prompt}
        disabled={blocked}
        onChange={(event) => {
          setPrompt(event.target.value)
          setTyping(true)
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey && !event.metaKey && !event.ctrlKey) {
            event.preventDefault()
            send(prompt)
          }
        }}
      />
    </>
  )

  if (!state) {
    // Nothing to unfold yet and nothing to send to: the field is the whole card.
    //
    // It is still a real field, and what is typed into it survives the handoff —
    // `reset` keeps the text when the session lands, so a fast typist never loses
    // the beginning of the question to the context collection finishing. Enter
    // before the session exists is a no-op rather than an error: `send` returns
    // without touching the text, and the same Enter works a moment later.
    return (
      <div ref={rootRef} className="bubble">
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
        </div>
      </div>
    )
  }

  const { context, flags, quickActions, setupNotice } = state
  const selection = context.selection
  const screenshot = context.screenshot
  /**
   * Everything the card decides about itself, in one place and out of this file.
   *
   * The flags are a pure function of the session, the drawer and the last request
   * — see `viewFlags.ts`. They used to be expressions here, which meant they could
   * only be checked by looking at the card.
   */
  const {
    showMeta,
    canPaste,
    agentOff,
    agentBlocked,
    actionAsk,
    hint,
    alert
  } = deriveView({
    session: state,
    expanded,
    hasAnswer,
    busy,
    failed: Boolean(failure),
    last
  })

  return (
    // While the assistant is painting on the screen the card turns into a much
    // thinner sheet of glass: the arrow exists to point at something *behind*
    // the card, and an opaque panel sitting on that very spot is what hides it.
    <div
      ref={rootRef}
      className="bubble"
      data-busy={busy || undefined}
      data-drawing={(drawn > 0 && !typing) || undefined}
    >
      <div className="bar">
        {composer}
        {busy && (
          <button
            className="stop"
            title="Остановить ответ"
            onClick={() => {
              const id = requestIdRef.current
              // The main process stops writing as soon as it is aborted and emits
              // nothing more, so the "busy" state has to be cleared here.
              requestIdRef.current = null
              setBusy(false)
              if (id) window.smartCursor.overlay.cancel(id)
            }}
          >
            <span aria-hidden />
          </button>
        )}
        <button
          className="toggle"
          data-open={expanded || undefined}
          data-alert={!expanded && alert ? true : undefined}
          aria-expanded={expanded}
          aria-label={expanded ? 'Свернуть' : 'Развернуть'}
          title={expanded ? 'Свернуть' : 'Контекст, подсказки и действия'}
          onClick={() => setExpanded((value) => !value)}
        >
          <svg viewBox="0 0 10 6" aria-hidden>
            <path d="M1 1l4 4 4-4" />
          </svg>
        </button>
      </div>

      {/* The turn is the bars above; only a failure is worth a line here. A
          successful transcript is already in the field (and the answer replaces
          it), so repeating it under the field reads as a second answer. */}
      {voice.phase === 'idle' && voice.error && voice.message && (
        <div className="line" data-tone="err">
          {voice.message}
        </div>
      )}

      {showMeta && (
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
                onClick={clearPointer}
                title="Убрать рисунок с экрана"
              >
                Рисунок {drawn} ×
              </button>
            )}
          </div>

          {!busy && !prompt && quickActions.length > 0 && !blocked && (
            <div className="suggestions">
              {quickActions.map((action) => (
                <button
                  key={action.id}
                  className="tag"
                  onClick={() => {
                    setPrompt(action.prompt)
                    setMode(action.mode)
                    send(action.prompt, action.mode)
                  }}
                  title={action.prompt}
                >
                  {action.label}
                </button>
              ))}
            </div>
          )}
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
          <button className="tag" onClick={() => window.smartCursor.settings.open()}>
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
      {agentOff && !blocked && !busy && (expanded || drawn > 0 || actionAsk) && (
        <div className="line" data-tone={actionAsk ? 'warn' : undefined}>
          <span>
            {actionAsk
              ? 'Это можно было сделать, а не показать: включите управление — и я нажму сам.'
              : 'Могу и нажать за вас — управление мышью пока выключено.'}
          </span>
          <button className="tag" onClick={() => void setAgentEnabled(true)}>
            Включить
          </button>
        </div>
      )}

      {/*
        Enabled but still blocked (almost always the Accessibility grant). The
        reason already arrived through `hint`; this adds the way out of it, since
        "нужен доступ" without a button is a dead end in a bubble this small.
      */}
      {expanded && agentBlocked && !blocked && !busy && (
        <div className="line">
          <button
            className="tag"
            onClick={() => window.smartCursor.permissions.open('accessibility')}
          >
            Открыть «Универсальный доступ»
          </button>
        </div>
      )}

      {/*
        What the machine is doing on the user's behalf. It sits above the answer
        and below the field on purpose: the plan is a sequence of steps in flight,
        so it belongs where a progress line belongs, not in the answer text — the
        answer is what will still be there afterwards.
      */}
      {agent && (
        <div className="agent" data-phase={agent.phase}>
          <div className="agent-head">
            <span className="agent-dot" aria-hidden />
            <span className="agent-label">
              {agent.phase === 'arming'
                ? 'Нажму через мгновение — Escape отменит'
                : agent.phase === 'aborted' || agent.phase === 'error'
                  ? (agent.message ?? 'Остановлено')
                  : /* `done` used to be a hard-coded «Готово» here. It is the
                       main process's word now: a turn that still has to check its
                       own result ends its plan on «Проверяю результат», and the
                       card must not print the verdict before the evidence. The
                       fallback covers an event that arrived without a label. */
                    agent.label || 'Готово'}
            </span>
            {agent.total > 0 && agent.phase !== 'done' && (
              <span className="agent-count">
                {agent.step}/{agent.total}
              </span>
            )}
            {/*
              Not a button on purpose. While a plan runs the card is click-through
              — that is the only way the synthetic clicks reach the app behind it —
              so a "Стоп" here would be a control the user cannot hit, which is
              worse than no control at all. Escape and a hand on the mouse are the
              real ones, and this says so. `checking` is included because the
              verification is another request the user is waiting on and Escape
              stops it the same way.
            */}
            {(agent.phase === 'arming' ||
              agent.phase === 'acting' ||
              agent.phase === 'checking') && (
              <span className="agent-hint">Esc — остановить</span>
            )}
          </div>
          {agent.skipped && agent.skipped.length > 0 && (
            <div className="agent-skip">
              Пропущено: {agent.skipped.join(' ')}
            </div>
          )}
          {agent.plan.length > 1 && (agent.phase === 'acting' || agent.phase === 'arming') && (
            <ol className="agent-plan">
              {agent.plan.map((line, index) => (
                <li
                  key={`${index}-${line}`}
                  data-state={
                    index + 1 < agent.step ? 'done' : index + 1 === agent.step ? 'now' : 'next'
                  }
                >
                  {line}
                </li>
              ))}
            </ol>
          )}
        </div>
      )}

      {failure && (
        <div className="line" data-tone="err">
          <span>{failure.message}</span>
          {failure.retryable && last && (
            <button
              className="tag"
              onClick={() =>
                last.refine
                  ? refine(last.refine, last.base)
                  : send(last.prompt, last.mode, last.voice)
              }
            >
              Повторить
            </button>
          )}
        </div>
      )}

      {/*
        Only real text earns an answer row. An empty "thinking" box under the
        field is what made a voice action look like it had answered something.
      */}
      {hasAnswer && (
        <div ref={answerRef} className="answer">
          {answer}
          {busy && <span className="caret" />}
        </div>
      )}

      {/* One action survives the fold: pasting the answer somewhere is what the
          bubble exists for. Rewrites and copying live behind the chevron. */}
      {hasAnswer && canPaste && (
        <div className="foot">
          <span className="spacer" />
          <button className="link primary" title="Вставить (⌘⏎)" onClick={() => void paste()}>
            {selection ? 'Заменить' : 'Вставить'}
          </button>
        </div>
      )}

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
              <span className="divider" />
              <button className="link" onClick={() => void copy()}>
                Копировать
              </button>
            </>
          )}
        </div>
      )}

      {notice && <div className="line">{notice}</div>}
    </div>
  )
}
