/** Draws the annotation paths and lays out their captions in screen coordinates. */

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

function arrowHead(shape: PointerShape): SVGElementTagNameMap['path'] {
  const dx = shape.to.x - shape.from.x
  const dy = shape.to.y - shape.from.y
  const angle = Math.atan2(dy, dx)
  const size = Math.min(16, Math.hypot(dx, dy))
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

type Rect = { left: number; top: number; right: number; bottom: number }

function targetBounds(shape: PointerShape): Rect {
  const { from, to } = shape
  if (shape.kind === 'arrow') {
    return { left: to.x - 6, top: to.y - 6, right: to.x + 6, bottom: to.y + 6 }
  }
  return {
    left: Math.min(from.x, to.x),
    top: Math.min(from.y, to.y),
    right: Math.max(from.x, to.x),
    bottom: Math.max(from.y, to.y)
  }
}

function overlap(a: Rect, b: Rect): number {
  // Leave room for the stroke and a small visual gap between captions.
  const gap = 4
  return (
    Math.max(0, Math.min(a.right, b.right + gap) - Math.max(a.left, b.left - gap)) *
    Math.max(0, Math.min(a.bottom, b.bottom + gap) - Math.max(a.top, b.top - gap))
  )
}

function placeLabel(
  width: number,
  height: number,
  shape: PointerShape,
  screen: { width: number; height: number },
  obstacles: Rect[]
): Rect {
  const { left, top, right, bottom } = targetBounds(shape)
  const gap = 8
  const margin = 6
  const below = { x: left, y: bottom + gap }
  const above = { x: left, y: top - height - gap }
  const after = { x: right + gap, y: top }
  const before = { x: left - width - gap, y: top }
  const candidates = shape.kind === 'underline'
    ? [below, above, after, before]
    : [after, before, below, above]
  // In a crowded corner, try just beyond the existing obstacles as well.
  const alternatives = obstacles.flatMap((obstacle) => [
    { x: left, y: obstacle.top - height - gap },
    { x: left, y: obstacle.bottom + gap }
  ]).sort((a, b) => Math.abs(a.y - top) - Math.abs(b.y - top))

  let best: Rect | undefined
  let leastOverlap = Infinity
  for (const { x, y } of [...candidates, ...alternatives]) {
    const clampedX = Math.max(margin, Math.min(x, screen.width - width - margin))
    const clampedY = Math.max(margin, Math.min(y, screen.height - height - margin))
    const rect = { left: clampedX, top: clampedY, right: clampedX + width, bottom: clampedY + height }
    const covered = obstacles.reduce((area, obstacle) => area + overlap(rect, obstacle), 0)
    if (covered === 0) return rect
    if (covered < leastOverlap) {
      best = rect
      leastOverlap = covered
    }
  }
  return best!
}

function renderShape(shape: PointerShape, delay: string): SVGGElement {
  const group = el('g', { class: 'pointer-shape' })
  group.style.setProperty('--delay', delay)

  const path = el('path', {
    d: pathFor(shape),
    class: 'pointer-stroke'
  })
  // `pathLength=1` normalises the dash maths for every shape, whatever its real
  // length, so one CSS rule animates circles, boxes and arrows identically.
  path.setAttribute('pathLength', '1')
  group.append(path)

  if (shape.kind === 'arrow') group.append(arrowHead(shape))
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

  const layer = document.createElement('div')
  layer.className = 'pointer-layer'
  const svg = el('svg', {
    width: payload.width,
    height: payload.height,
    viewBox: `0 0 ${payload.width} ${payload.height}`
  })
  layer.append(svg)
  const labels = payload.shapes.flatMap((shape, index) => {
    const delay = `${Math.min(index, 4) * 45}ms`
    svg.append(renderShape(shape, delay))
    if (!shape.label) return []

    const node = document.createElement('div')
    node.className = 'pointer-label'
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
