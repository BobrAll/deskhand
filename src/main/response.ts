/**
 * The one parser between a streaming answer and the two things it can do to the
 * screen: draw on it, and act on it.
 *
 * Text arrives as deltas, and a delta can end in the middle of a marker. The
 * parser therefore keeps exactly one piece of state — the tail of the current,
 * unfinished line — and refuses to emit it while it could still become a marker.
 * Everything before the last newline is decided immediately, which is what lets
 * an arrow appear (or a click happen) while the sentence explaining it is still
 * being written.
 *
 * Why not JSON: a stream cannot be parsed as JSON until its final byte, so a
 * JSON tool-call would arrive all at once, after the user has already read the
 * answer. A line protocol is the only shape that survives streaming.
 */

import type { AgentPlanStep, Annotation } from '@shared/types'
import { parseAnnotationLine } from './annotations'
import { parseAgentLine } from './agent/protocol'

export interface ParsedChunk {
  /** Answer text with every marker removed. */
  text: string
  annotations: Annotation[]
  steps: AgentPlanStep[]
}

export class ResponseStream {
  private pending = ''
  private shapes: Annotation[] = []
  private planned: AgentPlanStep[] = []
  webLookup = false
  invalidAction = false

  /** Feeds one delta; returns everything that can be acted on right now. */
  push(delta: string): ParsedChunk {
    this.pending += delta
    const result: ParsedChunk = { text: '', annotations: [], steps: [] }

    let newline = this.pending.indexOf('\n')
    while (newline !== -1) {
      const line = this.pending.slice(0, newline)
      this.pending = this.pending.slice(newline + 1)
      this.consume(line, result)
      newline = this.pending.indexOf('\n')
    }

    // A tail that still looks like the start of a marker waits for its newline;
    // flushing it would print "@cl" into the answer and then lose the click.
    if (this.pending.trimStart().startsWith('@')) {
      this.remember(result)
      return result
    }

    result.text += this.pending
    this.pending = ''
    this.remember(result)
    return result
  }

  /** Flushes whatever is left when the stream ends. */
  finish(): ParsedChunk {
    const tail = this.pending
    this.pending = ''
    const result: ParsedChunk = { text: '', annotations: [], steps: [] }
    if (!tail) return result
    this.consume(tail, result)
    this.remember(result)
    return result
  }

  /** Every shape asked for during this answer, in arrival order. */
  collected(): Annotation[] {
    return this.shapes
  }

  /** Every action asked for during this answer, in arrival order. */
  plan(): AgentPlanStep[] {
    return this.planned
  }

  private consume(line: string, result: ParsedChunk): void {
    if (line.trim() === '@web') {
      this.webLookup = true
      return
    }
    const steps = parseAgentLine(line)
    if (steps) {
      if (steps.length === 0) this.invalidAction = true
      result.steps.push(...steps)
      return
    }
    const annotation = parseAnnotationLine(line)
    if (annotation) {
      result.annotations.push(...annotation.annotations)
      if (annotation.text) result.text += `${annotation.text}\n`
      return
    }
    result.text += `${line}\n`
  }

  private remember(result: ParsedChunk): void {
    this.shapes.push(...result.annotations)
    this.planned.push(...result.steps)
  }
}
