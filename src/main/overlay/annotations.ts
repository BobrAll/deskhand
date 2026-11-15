import type { Annotation, AxElementInfo, ScreenRect } from '@shared/types'
import { groundAnnotation } from '../annotationGrounding'
import { hideAnnotations, showAnnotations } from '../drawing'

interface AnnotationHost {
  current(): { annotations: Annotation[] } | null
  setDrawing(drawing: boolean): void
  publishCount(count: number): void
}

export function createAnnotations({ current, setDrawing, publishCount }: AnnotationHost) {
  let typing = false

  /**
   * Decides whether the card should stand aside for a drawing.
   *
   * Two things bring it back to full density: the shapes going away, and the user
   * starting to write. Typing is the interesting one — at that moment the card is
   * what they are reading, so a 40% panel would be the wrong thing to type into
   * even though the arrow is still on screen.
   */
  function syncDrawing(): void {
    setDrawing((current()?.annotations.length ?? 0) > 0 && !typing)
  }

  function setTyping(value: boolean): void {
    if (typing === value) return
    typing = value
    syncDrawing()
  }

  /** Reports the current drawing state so the card can offer a "убрать" action. */
  function emitAnnotations(): void {
    const count = current()?.annotations.length ?? 0
    // The card's own density and the window's blur both follow this number;
    // routing them through here keeps the two from ever disagreeing.
    syncDrawing()
    publishCount(count)
  }

  /**
   * Takes the shapes off the screen and out of the session.
   *
   * The two always move together: a shape the display still paints after the
   * session forgot it would outlive the answer it was drawn for.
   */
  function discardAnnotations(): void {
    const session = current()
    if (session) session.annotations = []
    hideAnnotations()
    emitAnnotations()
  }

  /** Removes the drawings but keeps the card and the answer. */
  function clearAnnotations(): void {
    if (!current()) return
    discardAnnotations()
  }

  function resetDrawing(): void {
    hideAnnotations()
    typing = false
    setDrawing(false)
  }

  function createPainter(canDraw: boolean, area: ScreenRect | null, drawingTargets: AxElementInfo[] = []) {
    /**
     * Paints newly parsed shapes. Called as the stream arrives so the explanation
     * and the drawing grow together instead of the arrow appearing only after the
     * last token.
     *
     * Serialised through `painting`: two overlapping window updates would race,
     * and the loser could erase a shape the winner had already shown.
     */
    let dismissed = false
    let painting: Promise<void> = Promise.resolve()
    const paint = (shapes: Annotation[]): void => {
      const session = current()
      if (dismissed || shapes.length === 0 || !canDraw || !area || !session) return
      shapes = shapes.map((shape) => groundAnnotation(shape, drawingTargets, area))
      const next = [...session.annotations, ...shapes]
      session.annotations = next
      emitAnnotations()
      painting = painting
        .then(() => {
          if (dismissed) return
          return showAnnotations(area, next, () => {
            dismissed = true
            clearAnnotations()
          })
        })
        .catch(() => undefined)
    }

    return paint
  }

  return { setTyping, resetDrawing, clearAnnotations, discardAnnotations, createPainter }
}
