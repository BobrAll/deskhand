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
import { parseAnnotationLine } from './annotations'

export interface ParsedChunk {
  /** Answer text with every marker removed. */
  text: string
  annotations: Annotation[]
}

export class ResponseStream {
  private pending = ''
  webLookup = false

  /** Feeds one delta; returns everything that can be acted on right now. */
  push(delta: string): ParsedChunk {
    this.pending += delta
    const result: ParsedChunk = { text: '', annotations: [] }

    let newline = this.pending.indexOf('\n')
    while (newline !== -1) {
      const line = this.pending.slice(0, newline)
      this.pending = this.pending.slice(newline + 1)
      this.consume(line, result)
      newline = this.pending.indexOf('\n')
    }

    // A tail that still looks like the start of a marker waits for its newline;
    // flushing it would print "@po" into the answer and then lose the annotation.
    if (this.pending.trimStart().startsWith('@')) return result

    result.text += this.pending
    this.pending = ''
    return result
  }

  /** Flushes whatever is left when the stream ends. */
  finish(): ParsedChunk {
    const tail = this.pending
    this.pending = ''
    const result: ParsedChunk = { text: '', annotations: [] }
    if (!tail) return result
    this.consume(tail, result)
    return result
  }

  private consume(line: string, result: ParsedChunk): void {
    if (line.trim() === '@web') {
      this.webLookup = true
      return
    }
    const annotation = parseAnnotationLine(line)
    if (annotation) {
      result.annotations.push(...annotation.annotations)
      return
    }
    result.text += `${line}\n`
  }
}
