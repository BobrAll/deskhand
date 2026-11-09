/** Renders the screen glow and completion mark for an agent turn. */

import type { AgentCursorFrame } from '@shared/types'

const CHECK_GAP = 10
const CHECK_SIZE = 24
const MARGIN = 8

export interface CursorHighlight {
  render(frame: AgentCursorFrame): void
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max))
}

export function createCursor(root: HTMLElement): CursorHighlight {
  root.dataset.visible = 'false'
  root.dataset.phase = 'arming'

  const glow = document.createElement('div')
  glow.className = 'screen-glow'
  glow.setAttribute('aria-hidden', 'true')

  const tag = document.createElement('div')
  tag.className = 'tag'
  const check = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  check.classList.add('completion-check')
  check.setAttribute('viewBox', '0 0 24 24')
  check.setAttribute('aria-hidden', 'true')
  const checkPath = document.createElementNS('http://www.w3.org/2000/svg', 'path')
  checkPath.setAttribute('d', 'm5 12 4.5 4.5L19 7')
  checkPath.setAttribute('pathLength', '1')
  const checkOutline = checkPath.cloneNode(true) as SVGPathElement
  checkOutline.classList.add('completion-check-outline')
  check.append(checkOutline, checkPath)
  tag.append(check)

  root.append(glow, tag)

  function placeCheck(anchor: AgentCursorFrame['anchor']): void {
    const right = anchor.x + CHECK_GAP
    const below = anchor.y + CHECK_GAP
    const maxLeft = root.clientWidth - CHECK_SIZE - MARGIN
    const maxTop = root.clientHeight - CHECK_SIZE - MARGIN
    const left = clamp(right <= maxLeft ? right : anchor.x - CHECK_GAP - CHECK_SIZE, MARGIN, maxLeft)
    const top = clamp(below <= maxTop ? below : anchor.y - CHECK_GAP - CHECK_SIZE, MARGIN, maxTop)
    tag.style.translate = `${Math.round(left)}px ${Math.round(top)}px`
  }

  function render(frame: AgentCursorFrame): void {
    // Keep the last geometry while the layer fades out.
    root.dataset.visible = String(frame.visible)
    if (!frame.visible) return

    root.dataset.phase = frame.phase
    if (frame.phase === 'success') placeCheck(frame.anchor)
  }

  return { render }
}
