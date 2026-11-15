import { useCallback, useEffect, type KeyboardEvent as ReactKeyboardEvent, type MutableRefObject } from 'react'
import type { AgentEvent, AgentToolRequest } from '@shared/types'
import { hasTextSelection, keyPolicy, type KeyAction } from './keyPolicy'

interface OverlayKeysOptions {
  agentRef: MutableRefObject<AgentEvent | null>
  inputRef: MutableRefObject<HTMLTextAreaElement | null>
  promptRef: MutableRefObject<string>
  prompt: string
  answer: string
  /** Reads whether a turn is in flight without re-registering the listener. */
  isBusy(): boolean
  /** Reads whether the card has an answer to copy. */
  hasAnswerText(): boolean
  stopSpeech(): void
  markStoppedByUser(): void
  closeCard(): void
  cancelRequest(): void
  answerAgent(request: AgentToolRequest, allow: boolean, remember: boolean): Promise<void>
  copy(): Promise<void>
  send(text: string): void
}

export function useOverlayKeys({
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
}: OverlayKeysOptions) {
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
        stopSpeech()
        // The user ended this one, so the voice does not report it back to them.
        markStoppedByUser()
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
      if (action === 'copy') {
        void copy()
        return
      }
      send(promptRef.current)
    },
    [agentRef, answerAgent, cancelRequest, closeCard, copy, markStoppedByUser, promptRef, send, stopSpeech]
  )

  useEffect(() => {
    const handler = (event: KeyboardEvent): void => {
      const action = keyPolicy({
        key: event.key,
        meta: event.metaKey || event.ctrlKey,
        shift: event.shiftKey,
        tagName: (event.target as HTMLElement | null)?.tagName ?? null,
        agentPhase: agentRef.current?.phase ?? null,
        busy: isBusy(),
        runActive: Boolean(agentRef.current) && isBusy(),
        hasSelection: hasTextSelection(
          window.getSelection()?.toString() ?? '',
          document.activeElement === inputRef.current ? inputRef.current : null
        ),
        hasAnswer: hasAnswerText()
      })
      if (!action) return
      // ⌘C without a selection is ours; with one, `keyPolicy` has already said
      // `null` and the browser keeps the default copy.
      event.preventDefault()
      perform(action)
    }

    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [agentRef, hasAnswerText, inputRef, isBusy, perform])

  // The textarea handles Enter before the window fallback.
  const onPromptKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>): void => {
    if (
      keyPolicy({
        key: event.key,
        meta: event.metaKey || event.ctrlKey,
        shift: event.shiftKey,
        tagName: 'TEXTAREA',
        agentPhase: null,
        busy: isBusy(),
        runActive: false,
        hasSelection: false,
        hasAnswer: Boolean(answer.trim())
      }) !== 'send'
    ) {
      return
    }
    event.preventDefault()
    send(prompt)
  }

  return onPromptKeyDown
}
