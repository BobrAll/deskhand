import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  AgentEvent,
  AgentToolRequest,
  ContextSnapshot,
  OverlayState,
  RefineDirection,
  ResponseMode,
  StreamEvent
} from '@shared/types'
import { looksLikeAction } from '@shared/intent'
import { useAnswerScroll } from './useAnswerScroll'
import { useSpeech } from './useSpeech'
import { useWaiting } from './useWaiting'
import { useVoice } from './useVoice'
import { useOverlayKeys } from './useOverlayKeys'
import { useOverlayEvents } from './useOverlayEvents'
import { useAgentSpeech } from './useAgentSpeech'
import { useAnswerCopy } from './useAnswerCopy'
import { rewriteStartsOver, routeStream } from './streamRouting'

interface Failure {
  message: string
  retryable: boolean
}

/** The one notice that has a retry attached to it. */
export const AGENT_ENABLED_NOTICE = 'Управление включено. Повтори просьбу — теперь я её выполню.'

function newRequestId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

export function useOverlayController() {
  const speech = useSpeech()
  const speechRef = useRef(speech)
  speechRef.current = speech
  const [state, setState] = useState<OverlayState | null>(null)
  const [prompt, setPrompt] = useState('')
  const [answer, setAnswer] = useState('')
  const { answerRef, newText, onAnswerScroll, jumpToNewText, stopFollowing, resetScroll, prepareRewriteScroll } =
    useAnswerScroll(answer)
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
  /** The resize listener is registered once; it reads the latest typing state. */
  const typingRef = useRef(false)
  /** Option turns the whole card, text included, into a window handle. */
  const [dragAnywhere, setDragAnywhere] = useState(false)
  /**
   * The width the user chose for this card, or `null` while it sizes itself.
   *
   * It is state of the card and not of the settings: widening is something a
   * person does while reading one answer, and a preference that outlived the
   * answer would open the next short reply as a 560-point panel.
   */
  const [userWidth, setUserWidth] = useState<number | null>(null)
  /**
   * The card opens as a single small field. Everything else — context tags,
   * status rows and the answer's action strip — lives behind the
   * small chevron, so the common "ask and read" case stays one line tall.
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
  const { copied, resetCopied, copy } = useAnswerCopy(answerTextRef, setNotice)
  /**
   * What the turn in flight is: spoken or typed, an action or a question.
   *
   * The speech gate needs it after the turn is over — by the time a run ends,
   * the card no longer holds the prompt that started it.
   */
  const turnKindRef = useRef({ spoken: false, action: false })
  /** True when the user ended the run themselves, so its stop is not news. */
  const stoppedByUserRef = useRef(false)
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
  const clearTurn = useCallback(
    (typing: boolean) => {
      setAnswer('')
      setFailure(null)
      setNotice(null)
      resetCopied()
      resetScroll()
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
    },
    [resetCopied, resetScroll]
  )

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

  const { onAgentSpeech, clearProgress, finishTurnSpeech } = useAgentSpeech(speechRef, turnKindRef, stoppedByUserRef)

  /**
   * Reacts to stream events. `done` is the authoritative final text; a rewrite in
   * flight keeps the previous answer visible until the first chunk arrives.
   */
  const onStream = useCallback(
    (event: StreamEvent) => {
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
    },
    [finishTurnSpeech]
  )

  useEffect(() => {
    const setOption = (event: KeyboardEvent): void => {
      if (event.key === 'Alt') setDragAnywhere(event.type === 'keydown')
    }
    const reset = (): void => setDragAnywhere(false)
    window.addEventListener('keydown', setOption)
    window.addEventListener('keyup', setOption)
    window.addEventListener('blur', reset)
    return () => {
      window.removeEventListener('keydown', setOption)
      window.removeEventListener('keyup', setOption)
      window.removeEventListener('blur', reset)
    }
  }, [])

  const onPreparing = useCallback(() => {
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
  }, [clearTurn])
  const onContext = useCallback((snapshot: ContextSnapshot) => {
    setState((prev) => (prev ? { ...prev, context: snapshot } : prev))
  }, [])
  const onAgent = useCallback(
    (event: AgentEvent) => {
      agentRef.current = event.phase === 'idle' ? null : event
      setAgent(agentRef.current)
      onAgentSpeech(event)
    },
    [onAgentSpeech]
  )
  useOverlayEvents({ applyState, onPreparing, onContext, onStream, onDrawn: setDrawn, onAgent, clearProgress })

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
  // A setup problem or a failed request is not a detail: the card unfolds, so
  // the reason (and the way out of it) is never hidden behind a chevron.
  useEffect(() => {
    if (failure || state?.setupNotice) setExpanded(true)
  }, [failure, state?.setupNotice])

  const send = useCallback(
    (text: string, sendMode?: ResponseMode, spoken = false) => {
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
      resetCopied()
      stopFollowing()
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
    },
    [resetCopied, stopFollowing]
  )

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
      replaceOnChunkRef.current = rewriteStartsOver(answer)
      setBusy(true)
      // The answer is what the user reads while the rewrite runs, so the card
      // steps out of the way of the drawing exactly as it does on `send`.
      setTyping(false)
      setFailure(null)
      setNotice(null)
      resetCopied()
      // A rewrite is a writer turn; an agent summary from the previous turn
      // must not sit over the reworked text.
      setAgent(null)
      prepareRewriteScroll()
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
    [answer, last, resetCopied, prepareRewriteScroll]
  )

  /** Repeats whatever the last turn was: a question, or a rewrite and its base. */
  const retryLast = useCallback(() => {
    if (!last) return
    if (last.refine) refine(last.refine, last.base)
    else send(last.prompt, last.mode, last.spoken)
  }, [last, refine, send])

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
      setNotice(AGENT_ENABLED_NOTICE)
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
  const answerAgent = useCallback(async (request: AgentToolRequest, allow: boolean, remember: boolean) => {
    // A refusal ends the run; the run's own «Остановлено» would repeat the
    // decision the voice is about to name.
    if (!allow) stoppedByUserRef.current = true
    await window.deskhand.agent.answer(request.id, allow, remember)
    // The decision is the user's, so the line confirms it rather than the
    // agent's judgement — and the click that made it is already on the card.
    speechRef.current.say(allow ? (remember ? 'remembered' : 'approved') : 'denied', turnKindRef.current)
  }, [])

  /** Speech that has already been recognised and put into this card. */
  useEffect(() => {
    const off = window.deskhand.voice.onTranscript(({ text, send: autoSend }) => {
      // A new phrase replaces whatever the previous turn left on the card. The
      // answer belongs to the question that produced it; keeping it under a fresh
      // transcript is how an old answer appeared to "answer" the new phrase.
      setAnswer('')
      setFailure(null)
      setNotice(null)
      resetCopied()
      setAgent(null)
      stopFollowing()
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
  }, [resetCopied, stopFollowing])

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

  const stopSpeech = useCallback(() => speechRef.current.stop(), [])
  const markStoppedByUser = useCallback(() => {
    stoppedByUserRef.current = true
  }, [])
  const onPromptKeyDown = useOverlayKeys({
    agentRef,
    answerTextRef,
    busyRef,
    inputRef,
    promptRef,
    prompt,
    answer,
    stopSpeech,
    markStoppedByUser,
    closeCard,
    cancelRequest,
    answerAgent,
    copy,
    send
  })

  return {
    speech,
    state,
    prompt,
    setPrompt,
    answer,
    answerRef,
    newText,
    onAnswerScroll,
    jumpToNewText,
    busy,
    failure,
    notice,
    copied,
    drawn,
    typing,
    setTyping,
    typingRef,
    dragAnywhere,
    userWidth,
    setUserWidth,
    expanded,
    setExpanded,
    agent,
    last,
    inputRef,
    voice,
    listening,
    hasAnswer,
    waiting,
    waitStage,
    onPromptKeyDown,
    retryLast,
    toggleFlag,
    clearDrawing,
    setAgentEnabled,
    answerAgent,
    copy,
    closeCard,
    cancelRequest,
    refine
  }
}
