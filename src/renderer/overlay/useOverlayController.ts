import { useCallback, useEffect, useRef, useState } from 'react'
import type { AgentEvent, AgentToolRequest, ContextSnapshot, OverlayState } from '@shared/types'
import { useSpeech } from './useSpeech'
import { useWaiting } from './useWaiting'
import { useVoice } from './useVoice'
import { useOverlayKeys } from './useOverlayKeys'
import { useOverlayRequest } from './useOverlayRequest'
import { useOverlayEvents } from './useOverlayEvents'
import { useAgentSpeech } from './useAgentSpeech'

/** The one notice that has a retry attached to it. */
export const AGENT_ENABLED_NOTICE = 'Управление включено. Повтори просьбу — теперь я её выполню.'

export function useOverlayController() {
  const speech = useSpeech()
  const speechRef = useRef(speech)
  speechRef.current = speech
  const [state, setState] = useState<OverlayState | null>(null)
  const [prompt, setPrompt] = useState('')
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

  stateRef.current = state
  promptRef.current = prompt
  agentRef.current = agent
  typingRef.current = typing

  const {
    answer,
    answerRef,
    newText,
    onAnswerScroll,
    jumpToNewText,
    busy,
    failure,
    notice,
    setNotice,
    copied,
    copy,
    last,
    hasAnswerText,
    isBusy,
    currentRequestId,
    turnKind,
    markStoppedByUser,
    send,
    refine,
    retryLast,
    cancelRequest,
    cancelForVoice,
    clearRequest,
    clearAnswerForTranscript
  } = useOverlayRequest({
    stateRef,
    promptRef,
    inputRef,
    agentRef,
    speechRef,
    setPrompt,
    setTyping,
    setUserWidth,
    setAgent
  })
  // The run's own cues need the turn it belongs to, not the request hook's refs.
  const { onAgentSpeech, clearProgress } = useAgentSpeech(speechRef, turnKind)
  // Voice subscriptions use the current send command without resubscribing.
  sendRef.current = (text, spoken) => send(text, undefined, spoken)

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
      clearRequest()
      setDrawn(0)
      setTyping(typing)
      setExpanded(false)
      setUserWidth(null)
      setAgent(null)
    },
    [clearRequest]
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
  useOverlayEvents({ applyState, onPreparing, onContext, onDrawn: setDrawn, onAgent, clearProgress })

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
    cancelForVoice()
  }, [voice.phase, cancelForVoice])

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
  const waiting = useWaiting(currentRequestId(), busy && !failure && !listening)
  const waitStage = waiting.stage

  /**
   * A2: a wait long enough that the card may have been forgotten.
   *
   * Only a spoken turn reaches this: a typed question leaves the card on screen
   * with the same sentence already in it, and `speaksCue` says so.
   */
  useEffect(() => {
    if (waitStage !== 'long') return
    speechRef.current.say('longWait', turnKind())
  }, [turnKind, waitStage])

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
  const setAgentEnabled = useCallback(
    async (enabled: boolean) => {
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
    },
    [setNotice]
  )

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
      if (!allow) markStoppedByUser()
      await window.deskhand.agent.answer(request.id, allow, remember)
      // The decision is the user's, so the line confirms it rather than the
      // agent's judgement — and the click that made it is already on the card.
      speechRef.current.say(allow ? (remember ? 'remembered' : 'approved') : 'denied', turnKind())
    },
    [markStoppedByUser, turnKind]
  )

  /** Speech that has already been recognised and put into this card. */
  useEffect(() => {
    const off = window.deskhand.voice.onTranscript(({ text, send: autoSend }) => {
      // A new phrase replaces whatever the previous turn left on the card. The
      // answer belongs to the question that produced it; keeping it under a fresh
      // transcript is how an old answer appeared to "answer" the new phrase.
      clearAnswerForTranscript()
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
  }, [clearAnswerForTranscript])

  const closeCard = useCallback(() => {
    speechRef.current.stop()
    window.deskhand.overlay.close()
  }, [])

  const stopSpeech = useCallback(() => speechRef.current.stop(), [])
  const onPromptKeyDown = useOverlayKeys({
    agentRef,
    inputRef,
    promptRef,
    prompt,
    answer,
    isBusy,
    hasAnswerText,
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
