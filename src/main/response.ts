/**
 * The one parser between a streaming answer and what it can do to the screen.
 *
 * Text arrives as deltas, and a delta can end in the middle of a marker. The
 * parser therefore keeps exactly one piece of state — the tail of the current,
 * unfinished line — and refuses to emit it while it could still become a marker.
 * Everything before the last newline is decided immediately, which is what lets
 * an arrow appear while the sentence explaining it is still being written.
 *
 * Why not JSON: a stream cannot be parsed as JSON until its final byte, so a
 * JSON tool-call would arrive all at once, after the user has already read the
 * answer. A line protocol is the only shape that survives streaming.
 *
 * Only drawing is parsed here. Acting is not a tool of a text turn any more: a
 * request to *do* something goes to the agent, which has real tool calling and
 * does not need to encode its intent in prose. That is why this file got
 * smaller and the answer got cleaner — the model no longer has to spell its
 * clicks in the middle of a sentence.
 */

import type { Annotation } from '@shared/types'
import { couldStartMarker, parseAnnotationLine } from './annotations'

/** The lookup marker is a stream directive, not a drawing; it is decided here. */
const WEB_MARKER = '@web'

export interface ParsedChunk {
  /** Answer text with every marker removed. */
  text: string
  annotations: Annotation[]
}

export class ResponseStream {
  private pending = ''
  /**
   * Whether the line being accumulated has produced no answer text yet.
   *
   * A marker is only a marker at the start of a line. Once part of the line is
   * already in the answer, an `@point …` later in it is prose — which is why the
   * same model output must not draw or print depending on where the network cut
   * the chunk.
   */
  private atLineStart = true
  webLookup = false

  /** Feeds one delta; returns everything that can be acted on right now. */
  push(delta: string): ParsedChunk {
    this.pending += delta
    const result: ParsedChunk = { text: '', annotations: [] }

    let newline = this.pending.indexOf('\n')
    while (newline !== -1) {
      const line = this.pending.slice(0, newline)
      this.pending = this.pending.slice(newline + 1)
      if (this.atLineStart) this.consume(line, result)
      else result.text += `${line}\n`
      this.atLineStart = true
      newline = this.pending.indexOf('\n')
    }

    if (this.pending === '') return result

    // A tail that still looks like the start of a marker waits for its newline;
    // flushing it would print "@po" into the answer and then lose the annotation.
    if (this.atLineStart && this.couldBecomeMarker()) return result

    result.text += this.pending
    this.pending = ''
    this.atLineStart = false
    return result
  }

  /** Flushes whatever is left when the stream ends. */
  finish(): ParsedChunk {
    const tail = this.pending
    this.pending = ''
    const result: ParsedChunk = { text: '', annotations: [] }
    if (!tail) return result
    // A tail that never got its newline is still a line to the protocol — unless
    // it turns out to be prose. Prose is returned exactly as `push()` returns it,
    // without the newline `consume()` adds to a complete line.
    if (!this.applyMarker(tail, result)) result.text = tail
    return result
  }

  /**
   * Whether the tail could still turn into a marker line.
   *
   * Decided from the beginning of the line, not from wherever an `@` happens to
   * sit: once the line has produced text, a later `@point` in it is prose.
   */
  private couldBecomeMarker(): boolean {
    const trimmed = this.pending.trimStart()
    // Whitespace alone is held so that an indented marker — the prompt's own
    // example is written with two leading spaces — is dropped whole instead of
    // leaking its indent into the answer.
    if (trimmed === '') return true
    return couldStartMarker(trimmed) || WEB_MARKER.startsWith(trimmed.toLowerCase())
  }

  private consume(line: string, result: ParsedChunk): void {
    if (this.applyMarker(line, result)) return
    result.text += `${line}\n`
  }

  /** Applies a protocol line. Returns false when the line is ordinary prose. */
  private applyMarker(line: string, result: ParsedChunk): boolean {
    if (line.trim() === WEB_MARKER) {
      this.webLookup = true
      return true
    }
    const annotation = parseAnnotationLine(line)
    if (annotation) {
      result.annotations.push(...annotation.annotations)
      return true
    }
    return false
  }
}
