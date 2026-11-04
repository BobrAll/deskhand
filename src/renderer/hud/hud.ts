/**
 * Drawing the listening chip.
 *
 * The window is a transparent layer placed around the pointer, so this module's
 * job is small: hang one small glass capsule off the side of the cursor with the
 * most room, and open its bars with the loudness the main process forwards.
 *
 * Two details are deliberate:
 *
 * - the chip is the *only* thing that moves while a dictation runs. No halo
 *   around the pointer, no orb, no label, no timer: it sits next to the caret the
 *   user is already looking at, and every extra element there competes with the
 *   text being dictated into. The state is legible from the bars alone — a bounce
 *   means listening, a slow dim wave means recognising;
 * - the motion itself is CSS (`hud.css`), and the meter only scales the cluster
 *   through one custom property with a 120 ms transition. There is no
 *   `requestAnimationFrame` loop: a transparent window that repaints at 60 fps is
 *   a battery bug that surfaces days later as "the laptop gets warm while I
 *   type", and the bounce looks identical either way.
 */

import type { HudFrame, HudSide, VoiceHudPhase } from '@shared/types'

/** Must match `WIDTH` / `HEIGHT` in `src/main/hud.ts`. */
const LAYER_WIDTH = 320
const LAYER_HEIGHT = 160

/** Gap between the pointer and the chip, in points. Must match `GAP` in main. */
const GAP = 16

/** Keep the chip this far from the layer's edge when the layer is clamped. */
const MARGIN = 6

/** How many bars the capsule draws. Stay in step with the rule in `hud.css`. */
const BARS = 4

/** Only used before the first layout: `offsetWidth` is 0 until then. */
const FALLBACK_WIDTH = 40
const FALLBACK_HEIGHT = 22

export interface Hud {
  render(frame: HudFrame): void
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max))
}

export function createHud(root: HTMLElement): Hud {
  root.dataset.visible = 'false'
  root.dataset.phase = 'listening'

  const pill = document.createElement('div')
  pill.className = 'pill'
  const wave = document.createElement('span')
  wave.className = 'wave'
  for (let index = 0; index < BARS; index += 1) wave.append(document.createElement('i'))
  pill.append(wave)
  root.append(pill)

  /** Null until the first frame: it forces the phase attribute to be written. */
  let phase: VoiceHudPhase | null = null

  /** Puts the chip on the chosen side of the pointer. */
  function place(anchor: { x: number; y: number }, onSide: HudSide): void {
    // Measured, not assumed: the capsule's width comes from its padding and the
    // number of bars, and a hard-coded number would drift as soon as either is
    // edited.
    const width = pill.offsetWidth || FALLBACK_WIDTH
    const height = pill.offsetHeight || FALLBACK_HEIGHT

    let left: number
    let top: number
    switch (onSide) {
      case 'above':
        left = anchor.x - width / 2
        top = anchor.y - GAP - height
        break
      case 'right':
        left = anchor.x + GAP
        top = anchor.y - height / 2
        break
      case 'left':
        left = anchor.x - GAP - width
        top = anchor.y - height / 2
        break
      case 'below':
      default:
        left = anchor.x - width / 2
        top = anchor.y + GAP
        break
    }

    // The layer is clamped at the screen edge, so the pointer is not always in its
    // middle; nudging the chip back inside is what keeps it visible there. The top
    // is clamped on both sides: a chip that lands outside the layer simply does
    // not get drawn.
    left = clamp(left, MARGIN, Math.max(MARGIN, LAYER_WIDTH - width - MARGIN))
    top = clamp(top, MARGIN, Math.max(MARGIN, LAYER_HEIGHT - height - MARGIN))

    pill.style.left = `${Math.round(left)}px`
    pill.style.top = `${Math.round(top)}px`
  }

  function render(frame: HudFrame): void {
    if (!frame.visible) {
      if (root.dataset.visible === 'false') return
      root.dataset.visible = 'false'
      return
    }

    root.dataset.visible = 'true'

    if (frame.phase !== phase) {
      phase = frame.phase
      root.dataset.phase = phase
    }

    place(frame.anchor, frame.side)

    // One property, one transition: the bars keep bouncing on their own clock and
    // the cluster as a whole opens up with the voice. While recognising there is
    // no meter any more, so the wave runs at full height and does the talking.
    const level = clamp(frame.level, 0, 1)
    const amp = phase === 'listening' ? 0.62 + level * 0.55 : 1
    wave.style.setProperty('--amp', amp.toFixed(3))
  }

  return { render }
}
