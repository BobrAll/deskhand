/** Draws the annotation paths and lays out their captions in screen coordinates. */

import type { DrawingPayload, DrawingShape } from '@shared/types'
import { SVG_NS } from '../svg'

/** How rounded a box's corners are. */
const BOX_RADIUS = 14
/** The arrow head's longest side, and the half-angle it opens at. */
const ARROW_HEAD_SIZE = 16
const ARROW_HEAD_SPREAD = 0.42
/** How far around its tip an arrow's bounds reach, for caption placement. */
const ARROW_BOUNDS_PAD = 6
/** Room for the stroke and a small visual gap between two captions. */
const LABEL_OVERLAP_GAP = 4
/** Distance between a caption and the shape it belongs to. */
const LABEL_GAP = 8
/** Clearance a caption keeps from the screen edge. */
const LABEL_MARGIN = 6
/** How long the layer takes to fade out, matching `drawing.css`. */
const FADE_MS = 240
/** Stagger between captions, and how many of them are staggered at all. */
const STAGGER_MS = 45
const MAX_STAGGERED_LABELS = 4

function el<K extends keyof SVGElementTagNameMap>(
  name: K,
  attrs: Record<string, string | number>
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, name)
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value))
  return node
}

/** Rounds the corners of a rectangle path so a box looks hand-drawn, not clipped. */
function roundedRectPath(shape: DrawingShape, radius: number): string {
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
function circlePath(shape: DrawingShape): string {
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

function pathFor(shape: DrawingShape): string {
  switch (shape.kind) {
    case 'box':
      return roundedRectPath(shape, BOX_RADIUS)
    case 'circle':
      return circlePath(shape)
    case 'underline':
    case 'arrow':
    default:
      return `M${shape.from.x},${shape.from.y} L${shape.to.x},${shape.to.y}`
  }
}

function arrowHead(shape: DrawingShape): SVGElementTagNameMap['path'] {
  const dx = shape.to.x - shape.from.x
  const dy = shape.to.y - shape.from.y
  const angle = Math.atan2(dy, dx)
  const size = Math.min(ARROW_HEAD_SIZE, Math.hypot(dx, dy))
  const spread = ARROW_HEAD_SPREAD
  const left = angle + Math.PI - spread
  const right = angle + Math.PI + spread
  const d = [
    `M${shape.to.x},${shape.to.y}`,
    `L${shape.to.x + Math.cos(left) * size},${shape.to.y + Math.sin(left) * size}`,
    `M${shape.to.x},${shape.to.y}`,
    `L${shape.to.x + Math.cos(right) * size},${shape.to.y + Math.sin(right) * size}`
  ].join(' ')
  return el('path', { d, class: 'drawing-head' })
}

type Rect = { left: number; top: number; right: number; bottom: number }

function targetBounds(shape: DrawingShape): Rect {
  const { from, to } = shape
  if (shape.kind === 'arrow') {
    return {
      left: to.x - ARROW_BOUNDS_PAD,
      top: to.y - ARROW_BOUNDS_PAD,
      right: to.x + ARROW_BOUNDS_PAD,
      bottom: to.y + ARROW_BOUNDS_PAD
    }
  }
  return {
    left: Math.min(from.x, to.x),
    top: Math.min(from.y, to.y),
    right: Math.max(from.x, to.x),
    bottom: Math.max(from.y, to.y)
  }
}

function overlap(a: Rect, b: Rect): number {
  const width = Math.min(a.right, b.right + LABEL_OVERLAP_GAP) - Math.max(a.left, b.left - LABEL_OVERLAP_GAP)
  const height = Math.min(a.bottom, b.bottom + LABEL_OVERLAP_GAP) - Math.max(a.top, b.top - LABEL_OVERLAP_GAP)
  return Math.max(0, width) * Math.max(0, height)
}

/**
 * Every place a caption could sit, clamped onto the screen, in preference order.
 *
 * The first four are the sides of the shape itself; the rest are just beyond the
 * captions already placed, which is what keeps a crowded corner readable.
 */
function labelPlacements(
  width: number,
  height: number,
  shape: DrawingShape,
  screen: { width: number; height: number },
  obstacles: Rect[]
): Rect[] {
  const { left, top, right, bottom } = targetBounds(shape)
  const below = { x: left, y: bottom + LABEL_GAP }
  const above = { x: left, y: top - height - LABEL_GAP }
  const after = { x: right + LABEL_GAP, y: top }
  const before = { x: left - width - LABEL_GAP, y: top }
  const candidates = shape.kind === 'underline' ? [below, above, after, before] : [after, before, below, above]
  const alternatives = obstacles
    .flatMap((obstacle) => [
      { x: left, y: obstacle.top - height - LABEL_GAP },
      { x: left, y: obstacle.bottom + LABEL_GAP }
    ])
    .sort((a, b) => Math.abs(a.y - top) - Math.abs(b.y - top))

  return [...candidates, ...alternatives].map(({ x, y }) => {
    const clampedX = Math.max(LABEL_MARGIN, Math.min(x, screen.width - width - LABEL_MARGIN))
    const clampedY = Math.max(LABEL_MARGIN, Math.min(y, screen.height - height - LABEL_MARGIN))
    return { left: clampedX, top: clampedY, right: clampedX + width, bottom: clampedY + height }
  })
}

/** The first placement that covers nothing, or the one that covers the least. */
function leastCovered(placements: Rect[], obstacles: Rect[]): Rect {
  let best = placements[0]
  let leastOverlap = Infinity
  for (const rect of placements) {
    const covered = obstacles.reduce((area, obstacle) => area + overlap(rect, obstacle), 0)
    if (covered === 0) return rect
    if (covered < leastOverlap) {
      best = rect
      leastOverlap = covered
    }
  }
  return best
}

function placeLabel(
  width: number,
  height: number,
  shape: DrawingShape,
  screen: { width: number; height: number },
  obstacles: Rect[]
): Rect {
  return leastCovered(labelPlacements(width, height, shape, screen, obstacles), obstacles)
}

function renderShape(shape: DrawingShape, delay: string): SVGGElement {
  const group = el('g', { class: 'drawing-shape' })
  group.style.setProperty('--delay', delay)

  const path = el('path', {
    d: pathFor(shape),
    class: 'drawing-stroke'
  })
  // `pathLength=1` normalises the dash maths for every shape, whatever its real
  // length, so one CSS rule animates circles, boxes and arrows identically.
  path.setAttribute('pathLength', '1')
  group.append(path)

  if (shape.kind === 'arrow') group.append(arrowHead(shape))
  return group
}

/** Replaces the layer contents with `payload` (or fades everything out). */
export function render(root: HTMLElement, payload: DrawingPayload): void {
  root.style.width = `${payload.width}px`
  root.style.height = `${payload.height}px`

  if (!payload.visible || payload.shapes.length === 0) {
    root.classList.add('leaving')
    window.setTimeout(() => {
      // A newer payload may have arrived while the fade was running.
      if (root.classList.contains('leaving')) root.replaceChildren()
    }, FADE_MS)
    return
  }

  root.classList.remove('leaving')

  const layer = document.createElement('div')
  layer.className = 'drawing-layer'
  const svg = el('svg', {
    width: payload.width,
    height: payload.height,
    viewBox: `0 0 ${payload.width} ${payload.height}`
  })
  layer.append(svg)
  const labels = payload.shapes.flatMap((shape, index) => {
    const delay = `${Math.min(index, MAX_STAGGERED_LABELS) * STAGGER_MS}ms`
    svg.append(renderShape(shape, delay))
    if (!shape.label) return []

    const node = document.createElement('div')
    node.className = 'drawing-label'
    node.style.setProperty('--delay', delay)
    node.textContent = shape.label
    layer.append(node)
    return [{ node, shape }]
  })
  root.replaceChildren(layer)

  // Measure the wrapped captions in one layout pass, then position them.
  const sizes = labels.map(({ node }) => node.getBoundingClientRect())
  const obstacles = payload.shapes.map(targetBounds)
  labels.forEach(({ node, shape }, index) => {
    const { width, height } = sizes[index]
    const rect = placeLabel(width, height, shape, payload, obstacles)
    node.style.left = `${rect.left}px`
    node.style.top = `${rect.top}px`
    obstacles.push(rect)
  })
}
