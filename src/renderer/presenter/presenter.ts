/**
 * The ghost pointer.
 *
 * It is on screen for the whole run: a soft, low-contrast mark that waits where
 * it last was and drifts to the next target when one arrives. The movement is a
 * CSS transition, so the layer never animates on a timer the main process has
 * to wait for — a step that takes 4 ms on the machine still takes 4 ms.
 *
 * Nothing here can act. It receives a point and a gesture and paints them.
 */

import type { AgentGesture, AgentPointerFrame } from '@shared/types'

const NS = 'http://www.w3.org/2000/svg'

/** How long the arrow stays pressed after a click. */
const PRESS_MS = 260
/** How many ripples may be on screen at once during a fast batch. */
const MAX_RIPPLES = 3

/**
 * Where the arrow's tip sits inside its own box, in pixels.
 *
 * The point the layer receives is the pixel that will be clicked, so the tip —
 * not the corner of the icon — has to land on it. The number follows the path
 * below: `M5 3.2` in a 26-unit viewBox drawn at 20 px.
 */
const TIP_X = (5 / 26) * 20
const TIP_Y = (3.2 / 26) * 20

/** Gestures that deserve a faint ring where they land. */
const RINGING: ReadonlySet<AgentGesture> = new Set<AgentGesture>([
  'click',
  'secondary',
  'activate',
  'drag',
  'scroll'
])

export interface PresenterLayer {
  render(frame: AgentPointerFrame): void
}

function arrow(): SVGSVGElement {
  const svg = document.createElementNS(NS, 'svg')
  svg.setAttribute('viewBox', '0 0 26 26')
  svg.setAttribute('aria-hidden', 'true')

  const path = document.createElementNS(NS, 'path')
  path.setAttribute('class', 'arrow')
  // A slim, rounded pointer rather than the system arrow: the mark should read
  // as "here", not as a second mouse the user might try to grab.
  path.setAttribute(
    'd',
    'M5 3.2 L20.4 13.6 L13.4 15 L16.6 22.2 L13.8 23.4 L10.6 16.2 L5 20.9 Z'
  )
  svg.append(path)
  return svg
}

export function createPresenter(root: HTMLElement): PresenterLayer {
  root.dataset.visible = 'false'
  root.dataset.idle = 'true'

  const ring = document.createElement('div')
  ring.className = 'target-ring'
  ring.dataset.on = 'false'
  ring.setAttribute('aria-hidden', 'true')

  const pointer = document.createElement('div')
  pointer.className = 'virtual-pointer'
  pointer.dataset.press = 'false'
  pointer.setAttribute('aria-hidden', 'true')
  pointer.append(arrow())

  root.append(ring, pointer)

  let pressTimer: number | null = null
  let ripples: HTMLElement[] = []

  function moveTo(point: { x: number; y: number }): void {
    // Offset by the tip so the pixel the agent is about to click is the pixel
    // under the point of the arrow, not the corner of its box.
    pointer.style.transform = `translate(${point.x - TIP_X}px, ${point.y - TIP_Y}px)`
  }

  function press(): void {
    pointer.dataset.press = 'true'
    if (pressTimer !== null) window.clearTimeout(pressTimer)
    pressTimer = window.setTimeout(() => {
      pointer.dataset.press = 'false'
      pressTimer = null
    }, PRESS_MS)
  }

  function ripple(point: { x: number; y: number }): void {
    const node = document.createElement('div')
    node.className = 'ripple'
    node.style.left = `${point.x}px`
    node.style.top = `${point.y}px`
    root.append(node)
    ripples.push(node)
    // A batch can fire faster than the animation. Keeping the newest few means
    // the screen never fills with rings, and the oldest one is the one the eye
    // has already left.
    while (ripples.length > MAX_RIPPLES) ripples.shift()?.remove()
    node.addEventListener(
      'animationend',
      () => {
        node.remove()
        ripples = ripples.filter((entry) => entry !== node)
      },
      { once: true }
    )
  }

  function render(frame: AgentPointerFrame): void {
    root.dataset.visible = String(frame.visible)
    if (!frame.visible) {
      root.dataset.idle = 'true'
      ring.dataset.on = 'false'
      return
    }

    root.dataset.idle = String(frame.idle === true)

    if (frame.target) {
      ring.style.left = `${frame.target.x}px`
      ring.style.top = `${frame.target.y}px`
      ring.style.width = `${frame.target.width}px`
      ring.style.height = `${frame.target.height}px`
      ring.dataset.on = 'true'
    } else {
      ring.dataset.on = 'false'
    }

    if (frame.from) {
      // Start at the old position with no transition, commit it, then restore
      // the transition and move on the next frame. Without the forced reflow
      // both styles land in the same frame and the pointer teleports.
      pointer.style.transition = 'none'
      moveTo(frame.from)
      void pointer.offsetWidth
      pointer.style.transition = ''
      requestAnimationFrame(() => moveTo(frame.point))
    } else {
      moveTo(frame.point)
    }

    if (!frame.idle && frame.gesture && RINGING.has(frame.gesture)) {
      press()
      ripple(frame.point)
    }
  }

  return { render }
}
