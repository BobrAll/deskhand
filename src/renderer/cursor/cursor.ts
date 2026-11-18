/** Renders the screen glow for an agent turn. */

import type { AgentCursorFrame } from '@shared/types'

export interface CursorHighlight {
  render(frame: AgentCursorFrame): void
}

export function createCursor(root: HTMLElement): CursorHighlight {
  root.dataset.visible = 'false'
  root.dataset.phase = 'arming'

  const glow = document.createElement('div')
  glow.className = 'screen-glow'
  glow.setAttribute('aria-hidden', 'true')

  root.append(glow)

  function render(frame: AgentCursorFrame): void {
    // Keep the last phase while the layer fades out.
    root.dataset.visible = String(frame.visible)
    if (!frame.visible) return

    root.dataset.phase = frame.phase
  }

  return { render }
}
