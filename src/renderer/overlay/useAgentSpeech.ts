import { useCallback, useRef, type MutableRefObject } from 'react'
import type { AgentEvent } from '@shared/types'
import type { useSpeech } from './useSpeech'

/**
 * How long an agent run works before the voice says it is still going.
 *
 * Long enough that a normal run never reaches it, short enough that a person
 * waiting on a stuck step hears something before they conclude it died.
 */
const AGENT_PROGRESS_MS = 45_000

export function useAgentSpeech(
  speechRef: MutableRefObject<ReturnType<typeof useSpeech>>,
  turnKindRef: MutableRefObject<{ spoken: boolean; action: boolean }>,
  stoppedByUserRef: MutableRefObject<boolean>
) {
  /** The approval question already announced, so a repaint does not repeat it. */
  const approvalSaidRef = useRef<string | null>(null)
  /** Pending "still working" line for a long agent run; one per acting phase. */
  const progressTimerRef = useRef<number | null>(null)

  const clearProgress = useCallback(() => {
    if (progressTimerRef.current === null) return
    window.clearTimeout(progressTimerRef.current)
    progressTimerRef.current = null
  }, [])

  const onAgentSpeech = useCallback(
    (event: AgentEvent) => {
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
      } else clearProgress()
    },
    [clearProgress, speechRef, turnKindRef]
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
      const cue =
        result.phase === 'aborted'
          ? 'stopped'
          : result.phase === 'error'
            ? 'failed'
            : result.completed
              ? 'done'
              : 'incomplete'
      speech.say(cue, turnKindRef.current)
    },
    [speechRef, stoppedByUserRef, turnKindRef]
  )

  return { onAgentSpeech, clearProgress, finishTurnSpeech }
}
