import { useCallback, useRef, useState, type MutableRefObject } from 'react'
import type { AgentEvent, OverlayState, RefineDirection, ResponseMode, StreamEvent } from '@shared/types'
import { looksLikeAction } from '@shared/intent'
import { useAgentSpeech } from './useAgentSpeech'
import { useAnswerCopy } from './useAnswerCopy'
import { useAnswerScroll } from './useAnswerScroll'
import type { useSpeech } from './useSpeech'
import { rewriteStartsOver, routeStream } from './streamRouting'

export interface Failure {
  message: string
  retryable: boolean
}

function newRequestId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

interface OverlayRequestHost {
  stateRef: MutableRefObject<OverlayState | null>
  promptRef: MutableRefObject<string>
  inputRef: MutableRefObject<HTMLTextAreaElement | null>
  agentRef: MutableRefObject<AgentEvent | null>
  speechRef: MutableRefObject<ReturnType<typeof useSpeech>>
  setPrompt(prompt: string): void
  setTyping(typing: boolean): void
  setUserWidth(width: number | null): void
  setAgent(event: AgentEvent | null): void
}

export function useOverlayRequest({
  stateRef,
  promptRef,
  inputRef,
  agentRef,
  speechRef,
  setPrompt,
  setTyping,
  setUserWidth,
  setAgent
}: OverlayRequestHost) {
  const [answer, setAnswer] = useState('')
  const { answerRef, newText, onAnswerScroll, jumpToNewText, stopFollowing, resetScroll, prepareRewriteScroll } =
    useAnswerScroll(answer)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<Failure | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
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

  answerTextRef.current = answer
  busyRef.current = busy

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
    [agentRef, finishTurnSpeech, setPrompt, speechRef]
  )

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
    [resetCopied, setAgent, setPrompt, setTyping, setUserWidth, speechRef, stateRef, stopFollowing]
  )

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
    [answer, last, prepareRewriteScroll, resetCopied, setAgent, setTyping, speechRef, stateRef]
  )

  /** Repeats whatever the last turn was: a question, or a rewrite and its base. */
  const retryLast = useCallback(() => {
    if (!last) return
    if (last.refine) refine(last.refine, last.base)
    else send(last.prompt, last.mode, last.spoken)
  }, [last, refine, send])

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
  }, [inputRef, last, promptRef, setPrompt, setTyping, speechRef])

  const cancelForVoice = useCallback(() => {
    speechRef.current.stop()
    const id = requestIdRef.current
    if (!id) return
    ignoredRequestRef.current = id
    requestIdRef.current = null
    setBusy(false)
    setFailure(null)
    setAgent(null)
    window.deskhand.overlay.cancel(id)
  }, [setAgent, speechRef])

  const clearAnswerForTranscript = useCallback(() => {
    setAnswer('')
    setFailure(null)
    setNotice(null)
    resetCopied()
    stopFollowing()
  }, [resetCopied, stopFollowing])

  const clearRequest = useCallback(() => {
    setAnswer('')
    setFailure(null)
    setNotice(null)
    resetCopied()
    resetScroll()
    setBusy(false)
    requestIdRef.current = null
    replaceOnChunkRef.current = false
    spokenPromptRef.current = false
    turnKindRef.current = { spoken: false, action: false }
    stoppedByUserRef.current = false
  }, [resetCopied, resetScroll])

  return {
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
    answerTextRef,
    busyRef,
    requestIdRef,
    turnKindRef,
    stoppedByUserRef,
    onAgentSpeech,
    clearProgress,
    onStream,
    send,
    refine,
    retryLast,
    cancelRequest,
    cancelForVoice,
    clearRequest,
    clearAnswerForTranscript
  }
}
