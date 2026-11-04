import type { Annotation, AxElementInfo, ScreenRect } from '@shared/types'

function normalized(value: string): string {
  return value.normalize('NFKC').replace(/\s+/g, ' ').trim().toLocaleLowerCase()
}

/** Use exact, unambiguous AX names; never guess between repeated labels. */
export function groundAnnotation(
  annotation: Annotation,
  targets: AxElementInfo[],
  area: ScreenRect
): Annotation {
  if (!annotation.label || area.width <= 0 || area.height <= 0) return annotation
  const name = normalized(annotation.label)
  if (!name) return annotation
  const matches = targets.filter((element) => {
    const raw = element.title ?? element.description ?? (element.editable ? '' : element.value) ?? ''
    return normalized(String(raw)) === name && element.frame
  })
  if (matches.length !== 1) return annotation
  const rect = matches[0].frame!
  // Off-screen or oversized containers are not useful drawing targets.
  if (rect.width < 2 || rect.height < 2 || rect.width >= area.width * 0.95 ||
    rect.height >= area.height * 0.95 || rect.x < area.x || rect.y < area.y ||
    rect.x + rect.width > area.x + area.width || rect.y + rect.height > area.y + area.height) {
    return annotation
  }
  const from = { x: (rect.x - area.x) / area.width, y: (rect.y - area.y) / area.height }
  const to = { x: (rect.x + rect.width - area.x) / area.width,
    y: (rect.y + rect.height - area.y) / area.height }
  if (annotation.kind === 'arrow') {
    return { ...annotation, to: { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 } }
  }
  if (annotation.kind === 'underline') {
    return { ...annotation, from: { x: from.x, y: to.y }, to }
  }
  return { ...annotation, from, to }
}
