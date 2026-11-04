/**
 * Drawing the ring that follows the pointer during an agent run.
 *
 * The layer is display-sized and the ring is moved with the CSS `translate`
 * property, not by moving the window: the helper warps the cursor in one jump,
 * and a window move would arrive a frame late on the main thread. The animation
 * spells out the step ("Клик: «Экспорт»", "2/4") right where the user is already
 * looking, so a menu opening on its own is no longer a mystery.
 *
 * The motion is deliberately small: a static ring, one ripple per action, and a
 * breathing scale while a step runs. Anything louder at the cursor competes with
 * the app the assistant is operating, which is the thing the user has to watch.
 */

import type { AgentCursorFrame } from '@shared/types'

/** Same clearance as the chat bubble (`BUBBLE_GAP`). */
const CAPTION_GAP = 10

/** Keep the caption this far from the layer's edge. */
const MARGIN = 8

/** Only used before the first layout: `offsetWidth` is 0 until then. */
const FALLBACK_WIDTH = 180
const FALLBACK_HEIGHT = 28

export interface CursorHighlight {
  render(frame: AgentCursorFrame): void
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max))
}

export function createCursor(root: HTMLElement): CursorHighlight {
  root.dataset.visible = 'false'
  root.dataset.phase = 'arming'

  const ring = document.createElement('div')
  ring.className = 'ring'

  const ripple = document.createElement('div')
  ripple.className = 'ring-pulse'

  const tag = document.createElement('div')
  tag.className = 'tag'
  const count = document.createElement('span')
  count.className = 'tag-count'
  const label = document.createElement('span')
  label.className = 'tag-label'
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
  tag.append(check, count, label)

  root.append(ripple, ring, tag)

  /** -1 forces the first frame to play the entrance ripple. */
  let lastPulse = -1
  let lastLabel = ''
  /** `null` forces the first frame to apply the hidden state of the badge. */
  let lastCount: string | null = null

  /**
   * The caption's own size, measured only when its content changes.
   *
   * Reading `offsetWidth` on every follow frame (~60 Hz) would force a layout on
   * each one. The text and the badge are the only things that can change the
   * size, and both are already tracked.
   */
  let tagWidth = 0
  let tagHeight = 0

  function measureTag(): void {
    tagWidth = tag.offsetWidth || FALLBACK_WIDTH
    tagHeight = tag.offsetHeight || FALLBACK_HEIGHT
  }

  /**
   * Puts the caption next to the pointer.
   *
   * It is measured instead of assumed: the step badge appears and disappears and
   * the label changes length, so a hard-coded width would drift off-centre. When
   * the pointer is near an edge the caption slides inwards rather than being cut
   * off — a caption half off the display explains nothing.
   */
  function placeTag(anchor: { x: number; y: number }): void {
    const width = tagWidth || FALLBACK_WIDTH
    const height = tagHeight || FALLBACK_HEIGHT
    // Like chat: down and right, flipping only when the display edge requires it.
    const right = anchor.x + CAPTION_GAP
    const below = anchor.y + CAPTION_GAP
    const wantedLeft = right + width <= root.clientWidth - MARGIN
      ? right : anchor.x - CAPTION_GAP - width
    const left = clamp(wantedLeft, MARGIN, Math.max(MARGIN, root.clientWidth - width - MARGIN))
    const wanted = below + height <= root.clientHeight - MARGIN
      ? below : anchor.y - CAPTION_GAP - height
    const top = clamp(wanted, MARGIN, Math.max(MARGIN, root.clientHeight - height - MARGIN))
    tag.style.translate = `${Math.round(left)}px ${Math.round(top)}px`
  }

  function render(frame: AgentCursorFrame): void {
    // The fade-out keeps the last geometry: the window is hidden right after it.
    if (!frame.visible) {
      root.dataset.visible = 'false'
      return
    }

    root.style.setProperty('--x', `${Math.round(frame.anchor.x)}px`)
    root.style.setProperty('--y', `${Math.round(frame.anchor.y)}px`)
    const phaseChanged = root.dataset.phase !== frame.phase
    root.dataset.phase = frame.phase
    root.dataset.visible = 'true'

    // The escape hint only makes sense before the first action; during a run the
    // caption has to stay short enough to read in a glance.
    const text =
      frame.phase === 'arming'
        ? `${frame.label || 'Приготовился'} · Esc — остановить`
        : frame.label
    const labelChanged = text !== lastLabel
    if (labelChanged) {
      label.textContent = text
      lastLabel = text
    }

    const step = frame.step > 0 && frame.total > 0 ? `${frame.step}/${frame.total}` : ''
    const stepChanged = step !== lastCount
    if (stepChanged) {
      count.textContent = step
      count.hidden = step === ''
      lastCount = step
    }

    // The caption needs its final size before it can be centred on the pointer,
    // but that size has to be re-read only when the content or the display did.
    if (phaseChanged || labelChanged || stepChanged || tagWidth === 0) measureTag()
    placeTag(frame.anchor)

    // Replaying the ripple is what marks *this* action instead of the previous
    // one: toggling the class is not enough, the animation has to restart.
    if (frame.pulse !== lastPulse) {
      lastPulse = frame.pulse
      ripple.classList.remove('pulse')
      // Forcing a reflow restarts the CSS animation on the next frame.
      void ripple.offsetWidth
      ripple.classList.add('pulse')
    }
  }

  // A display change (another monitor, a resolution switch) changes the layer
  // size the caption is centred in.
  window.addEventListener('resize', () => {
    tagWidth = 0
  })

  return { render }
}
