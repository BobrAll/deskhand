/**
 * Turns a `PointerPayload` into SVG and injects it into the page.
 *
 * The whole point of this renderer is the animation: a shape that just appears
 * looks like a glitch, while a shape that is *drawn* — the stroke travelling
 * along the path, then a caption fading in — reads as someone standing next to
 * you with a marker. Both effects are pure CSS (`stroke-dashoffset`), so they run
 * on the compositor and cost nothing while a full-screen window is open.
 *
 * Re-rendering is wholesale rather than incremental: the payload is at most a
 * handful of shapes, and replacing the SVG guarantees the draw-in replays every
 * time the assistant points at something new.
 */

import type { PointerPayload, PointerShape } from '@shared/types'

const NS = 'http://www.w3.org/2000/svg'

function el<K extends keyof SVGElementTagNameMap>(
  name: K,
  attrs: Record<string, string | number>
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(NS, name)
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value))
  return node
}

/** Rounds the corners of a rectangle path so a box looks hand-drawn, not clipped. */
function roundedRectPath(shape: PointerShape, radius: number): string {
  const x = Math.min(shape.from.x, shape.to.x)
  const y = Math.min(shape.from.y, shape.to.y)
  const width = Math.abs(shape.to.x - shape.from.x)
  const height = Math.abs(shape.to.y - shape.from.y)
  const r = Math.max(0, Math.min(radius, width / 2, height / 2))
  return [
    `M${x + r},${y}`,
    `H${x + width - r}`,
    `A${r},${r} 0 0 1 ${x + width},${y + r}`,
    `V${y + height - r}`,
    `A${r},${r} 0 0 1 ${x + width - r},${y + height}`,
    `H${x + r}`,
    `A${r},${r} 0 0 1 ${x},${y + height - r}`,
    `V${y + r}`,
    `A${r},${r} 0 0 1 ${x + r},${y}`,
    'Z'
  ].join(' ')
}

/** A slightly lopsided ellipse — a perfect one looks computer-generated. */
function circlePath(shape: PointerShape): string {
  const x = Math.min(shape.from.x, shape.to.x)
  const y = Math.min(shape.from.y, shape.to.y)
  const width = Math.abs(shape.to.x - shape.from.x)
  const height = Math.abs(shape.to.y - shape.from.y)
  const cx = x + width / 2
  const cy = y + height / 2
  const rx = width / 2
  const ry = height / 2
  const startX = cx - rx
  const startY = cy + ry * 0.12
  return (
    `M${startX},${startY} ` +
    `C${cx - rx},${cy - ry * 1.18} ${cx + rx},${cy - ry * 1.18} ${cx + rx},${cy + ry * 0.06} ` +
    `C${cx + rx},${cy + ry * 1.1} ${cx - rx * 0.94},${cy + ry * 1.16} ${cx - rx * 0.86},${cy + ry * 0.3}`
  )
}

function pathFor(shape: PointerShape): string {
  switch (shape.kind) {
    case 'box':
      return roundedRectPath(shape, 14)
    case 'circle':
      return circlePath(shape)
    case 'underline':
    case 'arrow':
    default:
      return `M${shape.from.x},${shape.from.y} L${shape.to.x},${shape.to.y}`
  }
}

function arrowHead(shape: PointerShape, size = 17): SVGElementTagNameMap['path'] {
  const angle = Math.atan2(shape.to.y - shape.from.y, shape.to.x - shape.from.x)
  const spread = 0.42
  const left = angle + Math.PI - spread
  const right = angle + Math.PI + spread
  const d = [
    `M${shape.to.x},${shape.to.y}`,
    `L${shape.to.x + Math.cos(left) * size},${shape.to.y + Math.sin(left) * size}`,
    `M${shape.to.x},${shape.to.y}`,
    `L${shape.to.x + Math.cos(right) * size},${shape.to.y + Math.sin(right) * size}`
  ].join(' ')
  return el('path', { d, class: 'pointer-head' })
}

function label(
  shape: PointerShape,
  text: string,
  bounds: { width: number; height: number }
): SVGElementTagNameMap['g'] {
  const group = el('g', { class: 'pointer-label' })
  const paddingX = 9
  const fontSize = 15
  // Width is estimated instead of measured: `getBBox` would force layout during
  // the animation and the label only needs to look right, not to be exact.
  const width = Math.min(280, text.length * fontSize * 0.56 + paddingX * 2)
  const height = fontSize + 12

  // Where the caption would like to sit, relative to its shape. Clamping is kept
  // as a last resort instead of the main strategy: a caption shoved to the far
  // edge of the display is worse than one overlapping, because the user can no
  // longer tell which shape it belongs to.
  const gap = 10
  let x: number
  let y: number
  if (shape.kind === 'underline') {
    x = Math.min(shape.from.x, shape.to.x)
    y = Math.max(shape.from.y, shape.to.y) + gap
  } else if (shape.kind === 'arrow') {
    // Beside the head, on the side it points away from, so the text never sits on
    // the shaft the user is supposed to follow.
    x = shape.to.x >= shape.from.x ? shape.to.x + gap + 6 : shape.to.x - width - gap - 6
    y = shape.to.y - height - gap
  } else {
    x = Math.max(shape.from.x, shape.to.x) + gap
    y = Math.min(shape.from.y, shape.to.y)
  }

  const clampX = (value: number): number =>
    Math.max(6, Math.min(value, Math.max(6, bounds.width - width - 6)))
  const clampY = (value: number): number =>
    Math.max(6, Math.min(value, Math.max(6, bounds.height - height - 6)))

  // If the preferred position does not fit, try the opposite side of the shape
  // before accepting a clamp — that keeps the caption next to what it labels.
  if (x < 6 || x + width > bounds.width - 6) {
    if (shape.kind === 'arrow') {
      const mirrored = shape.to.x >= shape.from.x ? shape.to.x - width - gap - 6 : shape.to.x + gap + 6
      if (mirrored >= 6 && mirrored + width <= bounds.width - 6) x = mirrored
    } else if (shape.kind !== 'underline') {
      const mirrored = Math.min(shape.from.x, shape.to.x) - width - gap
      if (mirrored >= 6 && mirrored + width <= bounds.width - 6) x = mirrored
    }
  }
  if (y < 6) {
    // No room above: drop the caption below the shape instead.
    const below =
      shape.kind === 'arrow'
        ? shape.to.y + gap + 4
        : Math.max(shape.from.y, shape.to.y) + gap
    if (below + height <= bounds.height - 6) y = below
  }

  x = clampX(x)
  y = clampY(y)

  group.append(
    el('rect', {
      x,
      y,
      width,
      height,
      rx: height / 2,
      class: 'pointer-label-bg'
    })
  )
  const textNode = el('text', {
    x: x + paddingX,
    y: y + height / 2 + fontSize * 0.35,
    class: 'pointer-label-text'
  })
  textNode.textContent = text
  group.append(textNode)
  return group
}

/** Draws one shape, arrowheads and captions included. */
function renderShape(
  shape: PointerShape,
  index: number,
  bounds: { width: number; height: number }
): SVGElementTagNameMap['g'] {
  const group = el('g', { class: `pointer-shape kind-${shape.kind}` })
  // Stagger so a multi-shape answer reads as a sequence of gestures, and expose
  // the same delay to children through a custom property so the stroke does not
  // start drawing while its group is still invisible.
  group.style.setProperty('--delay', `${index * 130}ms`)

  const path = el('path', {
    d: pathFor(shape),
    class: 'pointer-stroke',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round'
  })
  // `pathLength=1` normalises the dash maths for every shape, whatever its real
  // length, so one CSS rule animates circles, boxes and arrows identically.
  path.setAttribute('pathLength', '1')
  group.append(path)

  if (shape.kind === 'arrow') group.append(arrowHead(shape))
  if (shape.label) group.append(label(shape, shape.label, bounds))
  return group
}

/** Replaces the layer contents with `payload` (or fades everything out). */
export function render(root: HTMLElement, payload: PointerPayload): void {
  root.style.width = `${payload.width}px`
  root.style.height = `${payload.height}px`

  if (!payload.visible || payload.shapes.length === 0) {
    root.classList.add('leaving')
    window.setTimeout(() => {
      // A newer payload may have arrived while the fade was running.
      if (root.classList.contains('leaving')) root.replaceChildren()
    }, 240)
    return
  }

  root.classList.remove('leaving')

  const bounds = { width: payload.width, height: payload.height }
  const svg = el('svg', {
    width: payload.width,
    height: payload.height,
    viewBox: `0 0 ${payload.width} ${payload.height}`,
    class: 'pointer-layer'
  })
  payload.shapes.forEach((shape, index) => svg.append(renderShape(shape, index, bounds)))

  root.replaceChildren(svg)
}
