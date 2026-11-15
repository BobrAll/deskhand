import { useEffect } from 'react'
import type { AgentEvent, ContextSnapshot, OverlayState, StreamEvent } from '@shared/types'

interface OverlayEventHandlers {
  applyState(state: OverlayState): void
  onPreparing(): void
  onContext(snapshot: ContextSnapshot): void
  onStream(event: StreamEvent): void
  onDrawn(count: number): void
  onAgent(event: AgentEvent): void
  clearProgress(): void
}

export function useOverlayEvents({
  applyState,
  onPreparing,
  onContext,
  onStream,
  onDrawn,
  onAgent,
  clearProgress
}: OverlayEventHandlers) {
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
        .then((next) => {
          if (next) applyState(next)
        })
        .catch(() => undefined)
    }
    window.addEventListener('focus', refresh)
    return () => window.removeEventListener('focus', refresh)
  }, [applyState])

  useEffect(() => {
    // No session yet means the card is the empty one drawn while the context is
    // being collected — and it must *not* take the keyboard here. Focusing the
    // field would make this window the frontmost app, and `collectContext` reads
    // the frontmost app: the target would come back as the assistant itself. The
    // focus is taken in `reset`, once the session it belongs to exists.
    void window.deskhand.overlay
      .getState()
      .then((next) => {
        if (next) applyState(next)
      })
      .catch(() => undefined)

    const offState = window.deskhand.overlay.onState(applyState)
    const offPreparing = window.deskhand.overlay.onPreparing(onPreparing)
    const offContext = window.deskhand.overlay.onContextUpdate(onContext)
    const offStream = window.deskhand.overlay.onStream(onStream)
    const offAnnotations = window.deskhand.overlay.onAnnotations(({ count }) => onDrawn(count))
    const offAgent = window.deskhand.agent.onEvent(onAgent)

    return () => {
      offState()
      offPreparing()
      offContext()
      offStream()
      offAnnotations()
      offAgent()
      clearProgress()
    }
  }, [applyState, onPreparing, onContext, onStream, onDrawn, onAgent, clearProgress])
}
