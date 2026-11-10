import { useEffect, useState } from 'react'
import { WAIT_LONG_MS, WAIT_STATUS_MS, WAIT_TIP_MS, WAITING_TIPS } from './waiting'

let nextTip = 0

/** One clock per request; streamed text and real agent statuses take priority. */
export function useWaiting(requestId: string | null, active: boolean) {
  const [state, setState] = useState({ id: '', elapsed: 0, tip: '' })
  useEffect(() => {
    if (!active || !requestId) return
    const tip = WAITING_TIPS[nextTip++ % WAITING_TIPS.length]
    setState({ id: requestId, elapsed: 0, tip })
    const timers = [WAIT_STATUS_MS, WAIT_TIP_MS, WAIT_LONG_MS].map(elapsed =>
      setTimeout(() => setState({ id: requestId, elapsed, tip }), elapsed)
    )
    return () => timers.forEach(clearTimeout)
  }, [requestId, active])
  return active && state.id === requestId ? state : { elapsed: 0, tip: '' }
}
