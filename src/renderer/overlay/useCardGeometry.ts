import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import type { Dispatch, KeyboardEvent, MutableRefObject, PointerEvent, SetStateAction } from 'react'
import { CARD_WIDTH } from '@shared/metrics'
import { layoutCard, structuredAnswer } from './cardLayout'
import { FIELD_FONT } from './cardMetrics'
import { draggedWidth, expandedWidth } from './cardWidth'

type LayoutInputs = Omit<Parameters<typeof layoutCard>[0], 'font' | 'structured' | 'userWidth' | 'availWidth'>

interface CardGeometryOptions extends LayoutInputs {
  inputRef: MutableRefObject<HTMLTextAreaElement | null>
  typingRef: MutableRefObject<boolean>
  userWidth: number | null
  setUserWidth: Dispatch<SetStateAction<number | null>>
}

export function useCardGeometry({
  inputRef,
  typingRef,
  userWidth,
  setUserWidth,
  ...layoutInputs
}: CardGeometryOptions) {
  const { wantsWide } = layoutInputs

  /** A width drag is in flight; `report` outlives a render, so it reads a ref. */
  const draggingRef = useRef(false)
  const dragRef = useRef<{ startX: number; startWidth: number; width: number } | null>(null)
  const [dragging, setDragging] = useState(false)
  /**
   * The font the field renders in, resolved from the live element.
   *
   * The measuring canvas has to shape the question exactly as the textarea does,
   * and the element's own computed style is the only honest source for that: the
   * font arrives from `base.css`, and macOS may resolve the family differently
   * from what the stylesheet names. The ref callback refreshes it whenever the
   * field is mounted — which is also the only time the answer can change.
   */
  const fontRef = useRef(FIELD_FONT)
  const fieldRef = useCallback(
    (node: HTMLTextAreaElement | null) => {
      inputRef.current = node
      if (!node) return
      node.focus()
      const style = window.getComputedStyle(node)
      fontRef.current = style.font || `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`
    },
    [inputRef]
  )
  /**
   * The card's outermost element, as state rather than a ref.
   *
   * There are two different roots — the voice bars and the card — and React mounts
   * a new element when the component switches between them. A `useRef` would still
   * point at the detached one, and the ResizeObserver would keep watching a node
   * that is no longer on screen: the window would then be sized by whichever root
   * happened to exist when the effect last ran.
   */
  const [rootNode, setRootNode] = useState<HTMLDivElement | null>(null)
  const rootRef = useCallback((node: HTMLDivElement | null) => setRootNode(node), [])
  /**
   * The width the card takes, and whether the question wraps in it.
   *
   * The composition lives in `cardLayout.ts`, where it can be checked without a
   * card. The one input that is not state is the field's font: it has to be the
   * live element's own computed style, because macOS may resolve the family
   * differently from what the stylesheet names.
   */
  const {
    width: cardWidth,
    wrapped,
    naturalWidth
  } = layoutCard({
    ...layoutInputs,
    font: fontRef.current,
    structured: structuredAnswer(layoutInputs.answer),
    // While a drag runs the width lives in a ref, because updating state a hundred
    // times a second re-renders the answer for nothing. But a render can still
    // happen mid-drag — the next chunk of a streaming answer is exactly that — and
    // React would then write its own width over the dragged one. Reading the live
    // value here makes such a render agree with the edge instead of fighting it.
    userWidth: dragRef.current?.width ?? userWidth,
    availWidth: window.screen.availWidth
  })

  // Measure layout, not the entrance transform. getBoundingClientRect includes
  // the appear animation's scale, which used to feed false heights back to macOS.
  const resizeWindowToLayoutRef = useRef<() => void>(() => {})
  useLayoutEffect(() => {
    const node = rootNode
    if (!node) return
    let lastWidth = 0
    let lastHeight = 0
    const resizeWindowToLayout = (): void => {
      const width = node.offsetWidth
      const height = node.offsetHeight
      if (width === lastWidth && height === lastHeight) return
      lastWidth = width
      lastHeight = height
      // `pin` while a drag is in flight: the right edge is under the pointer, so
      // the card has to grow away from its left edge instead of from the anchor.
      window.deskhand.overlay.resize(height, width, draggingRef.current, typingRef.current)
    }
    const onFocus = (): void => {
      lastWidth = lastHeight = 0
      resizeWindowToLayout()
      inputRef.current?.focus()
    }
    resizeWindowToLayoutRef.current = resizeWindowToLayout
    const observer = new ResizeObserver(resizeWindowToLayout)
    observer.observe(node)
    resizeWindowToLayout()
    window.addEventListener('focus', onFocus)
    return () => {
      resizeWindowToLayoutRef.current = () => {}
      observer.disconnect()
      window.removeEventListener('focus', onFocus)
    }
  }, [rootNode, inputRef, typingRef])

  // Chromium sizes the field from its content. Report the final layout before
  // paint without temporarily collapsing the focused textarea to measure it.
  useLayoutEffect(() => {
    resizeWindowToLayoutRef.current()
  }, [layoutInputs.prompt, cardWidth, wrapped, rootNode])

  /**
   * The width the content itself wants, and the one «Шире» opens to.
   *
   * `null` means the content already fits the card: there is nothing to widen,
   * so the button is not shown. `userWidth` set means the person has taken the
   * width over, and «Вернуть» gives it back to the content.
   */
  const wanted = expandedWidth(naturalWidth, window.screen.availWidth)

  const toggleWidth = useCallback(() => {
    setUserWidth(userWidth === null ? wanted : null)
  }, [userWidth, wanted, setUserWidth])

  /**
   * Dragging the card's right edge.
   *
   * Three things make this feel like an edge and not like a slider:
   *
   * - The delta comes from the pointer's *screen* position, not from its position
   *   inside the window. The window moves and resizes while the drag runs, so a
   *   client-space delta would fold the card's own motion back into the pointer
   *   and the edge would slide away from the hand pulling it.
   * - The width is written straight onto the element and never through React.
   *   A state update per pointer move re-renders the whole card — the answer's
   *   Markdown included — a hundred times a second, and the card lags behind the
   *   hand by exactly that much. State is committed once, on release.
   * - The window follows from the element: the `ResizeObserver` in
   *   `resizeWindowToLayout` sees the new width and resizes the window with
   *   `pin`, so the left edge stays put and the right edge tracks the pointer.
   *   There is one resize path, not two.
   */
  const gripDown = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return
      const node = rootNode
      if (!node) return
      event.preventDefault()
      event.currentTarget.setPointerCapture(event.pointerId)
      dragRef.current = { startX: event.screenX, startWidth: node.offsetWidth, width: node.offsetWidth }
      draggingRef.current = true
      setDragging(true)
    },
    [rootNode]
  )

  const gripMove = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current
      const node = rootNode
      if (!drag || !node) return
      // The drawer's buttons need the full width, so an unfolded card cannot be
      // dragged narrower than that: it would snap back on release.
      const floor = wantsWide ? CARD_WIDTH : undefined
      const width = draggedWidth(drag.startWidth, event.screenX - drag.startX, window.screen.availWidth, floor)
      if (width === drag.width) return
      drag.width = width
      node.style.width = `${width}px`
    },
    [rootNode, wantsWide]
  )

  /**
   * The same edge, without a pointer.
   *
   * The drag has a keyboard twin rather than being reported as cosmetic: the edge
   * is the only way to widen a table past the card, and a window splitter that
   * cannot be reached from the keyboard is a control half the users do not have.
   * The step is small enough to read as nudging and repeats while held; Shift
   * makes it a coarse jump.
   */
  const gripKey = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
      event.preventDefault()
      const step = event.shiftKey ? 64 : 16
      const floor = wantsWide ? CARD_WIDTH : undefined
      const from = userWidth ?? cardWidth
      setUserWidth(draggedWidth(from, event.key === 'ArrowRight' ? step : -step, window.screen.availWidth, floor))
    },
    [wantsWide, userWidth, cardWidth, setUserWidth]
  )

  const gripUp = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current
      if (!drag) return
      dragRef.current = null
      draggingRef.current = false
      setDragging(false)
      // One commit for the whole gesture. Until this render the element carries the
      // dragged width imperatively, so React writing the same number changes
      // nothing on screen.
      setUserWidth(drag.width)
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId)
      }
    },
    [setUserWidth]
  )

  return { cardWidth, wrapped, rootRef, fieldRef, wanted, toggleWidth, dragging, gripDown, gripMove, gripUp, gripKey }
}
