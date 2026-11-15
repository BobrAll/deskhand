import { useEffect, useState } from 'react'
import { WAIT_LONG_MS, WAIT_STATUS_MS, WAIT_TIP_MS, WAITING_TIPS, type WaitStage, waitingStage } from './waiting'

/**
 * The rotation is deliberately one counter for the whole renderer, not one per
 * card: the tips are a single deck, and a card that is reopened on the next
 * question continues it instead of showing the first tip again.
 */
let nextTip = 0

/** What the card knows about a wait, in one value the render can read. */
export interface WaitingClock {
  /** The request this clock belongs to; empty when there is none. */
  id: string
  /** How long the request has been running. */
  elapsed: number
  /** The tip chosen when the wait began; it does not change mid-request. */
  tip: string
  /** Which waiting row the card shows for that elapsed time. */
  stage: WaitStage
}

/** The clock of a card that is not waiting: nothing elapsed, nothing to say. */
const NO_WAIT: WaitingClock = { id: '', elapsed: 0, tip: '', stage: 'quiet' }

/** One clock per request; streamed text and real agent statuses take priority. */
export function useWaiting(requestId: string | null, active: boolean): WaitingClock {
  const [clock, setClock] = useState<WaitingClock>(NO_WAIT)
  useEffect(() => {
    if (!active || !requestId) return
    const tip = WAITING_TIPS[nextTip++ % WAITING_TIPS.length]
    const at = (elapsed: number): WaitingClock => ({
      id: requestId,
      elapsed,
      tip,
      stage: waitingStage(elapsed)
    })
    setClock(at(0))
    const timers = [WAIT_STATUS_MS, WAIT_TIP_MS, WAIT_LONG_MS].map((elapsed) =>
      setTimeout(() => setClock(at(elapsed)), elapsed)
    )
    return () => timers.forEach(clearTimeout)
  }, [requestId, active])
  return active && clock.id === requestId ? clock : NO_WAIT
}
