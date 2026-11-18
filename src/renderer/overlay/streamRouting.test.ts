/**
 * Which events reach the card.
 *
 * The two cases that matter are the ones nobody sees: a chunk for a request the
 * card has given up on (the user cancelled, the card stopped waiting, and a chunk
 * already in flight arrives anyway) and a chunk for a request that is not the one
 * on screen. Both would append text to an answer nobody asked for any more, and
 * neither throws.
 */

import { describe, expect, it } from 'vitest'
import type { StreamEvent } from '@shared/types'
import { rewriteStartsOver, routeStream, type StreamState } from './streamRouting'

const chunk = (requestId: string, delta: string): StreamEvent => ({ type: 'chunk', requestId, delta })
const done = (requestId: string, text: string): StreamEvent => ({
  type: 'done',
  requestId,
  text,
  annotations: 0
})
const error = (requestId: string, message: string): StreamEvent => ({
  type: 'error',
  requestId,
  message,
  retryable: true
})

/** The card waiting on `r1`, with a spoken phrase still in the field. */
function state(overrides: Partial<StreamState> = {}): StreamState {
  return {
    requestId: 'r1',
    ignoredRequest: null,
    replaceOnChunk: false,
    spokenPrompt: false,
    ...overrides
  }
}

describe('routeStream: the request has to be ours', () => {
  it('ignores a chunk for a request the card has given up on', () => {
    const action = routeStream(chunk('r0', 'поздно'), state({ ignoredRequest: 'r0' }))

    expect(action).toEqual({ kind: 'ignore' })
  })

  it('ignores every event kind for an abandoned request', () => {
    for (const event of [chunk('r0', 'x'), done('r0', 'x'), error('r0', 'x')]) {
      expect(routeStream(event, state({ ignoredRequest: 'r0' })), event.type).toEqual({ kind: 'ignore' })
    }
  })

  it('ignores a chunk for a different request than the one on screen', () => {
    expect(routeStream(chunk('r2', 'чужое'), state())).toEqual({ kind: 'ignore' })
  })

  it('lets the awaited request through', () => {
    expect(routeStream(chunk('r1', 'наш'), state())).toEqual({
      kind: 'append',
      text: 'наш',
      clearSpoken: false
    })
  })

  it('prefers the ignored request over the awaited one', () => {
    // Both refs point at the same id only if something has gone wrong, but the
    // order is part of the contract: given up on wins.
    const action = routeStream(chunk('r1', 'x'), state({ ignoredRequest: 'r1' }))

    expect(action).toEqual({ kind: 'ignore' })
  })
})

describe('routeStream: replacing instead of appending', () => {
  it('replaces the answer with a rewrite’s first chunk', () => {
    expect(routeStream(chunk('r1', 'короче'), state({ replaceOnChunk: true }))).toEqual({
      kind: 'replace',
      text: 'короче',
      clearSpoken: false
    })
  })

  it('appends once the replace flag is spent', () => {
    // `replaceOnChunk` is a one-shot: the caller clears it, and the next chunk of
    // the same answer extends what the first one started.
    expect(routeStream(chunk('r1', ' ещё'), state({ replaceOnChunk: false }))).toEqual({
      kind: 'append',
      text: ' ещё',
      clearSpoken: false
    })
  })

  it('carries an empty delta through rather than dropping it', () => {
    // An empty chunk still means "the answer has started": it is what clears the
    // spoken phrase and the replace flag.
    expect(routeStream(chunk('r1', ''), state({ replaceOnChunk: true, spokenPrompt: true }))).toEqual({
      kind: 'replace',
      text: '',
      clearSpoken: true
    })
  })
})

describe('rewriteStartsOver: the rewrite replaces what is on screen', () => {
  it('replaces the answer the rewrite starts from, retry included', () => {
    // A failed rewrite leaves its base on screen, and «Повторить» starts from
    // that same base. Appending the retry's chunks would glue them to the answer
    // the attempt is supposed to replace, so the rule may not depend on where the
    // base came from.
    expect(rewriteStartsOver('старый ответ')).toBe(true)
  })

  it('has nothing to replace when the card is empty', () => {
    expect(rewriteStartsOver('   ')).toBe(false)
  })
})

describe('routeStream: the spoken phrase', () => {
  it('is cleared by the first chunk', () => {
    expect(routeStream(chunk('r1', 'x'), state({ spokenPrompt: true })).kind).toBe('append')
    expect(routeStream(chunk('r1', 'x'), state({ spokenPrompt: true }))).toMatchObject({ clearSpoken: true })
  })

  it('is cleared by a turn that never streamed', () => {
    // An action with no prose, or a failure: the card stopped working on the
    // phrase either way, and leaving it in the field is the leftover question
    // every follow-up had to be appended to.
    expect(routeStream(done('r1', ''), state({ spokenPrompt: true }))).toMatchObject({ clearSpoken: true })
    expect(routeStream(error('r1', 'нет сети'), state({ spokenPrompt: true }))).toMatchObject({
      clearSpoken: true
    })
  })

  it('is not reported when there is nothing to clear', () => {
    expect(routeStream(done('r1', 'ответ'), state())).toMatchObject({ clearSpoken: false })
  })
})

describe('routeStream: the end of a turn', () => {
  it('takes `done` as the authoritative text', () => {
    expect(routeStream(done('r1', 'итог'), state())).toEqual({
      kind: 'done',
      text: 'итог',
      clearSpoken: false
    })
  })

  it('carries the retry flag of a failure', () => {
    expect(routeStream(error('r1', 'нет сети'), state())).toEqual({
      kind: 'error',
      message: 'нет сети',
      retryable: true,
      clearSpoken: false
    })
  })

  it('keeps `done` and `error` apart', () => {
    expect(routeStream(done('r1', 'x'), state()).kind).toBe('done')
    expect(routeStream(error('r1', 'x'), state()).kind).toBe('error')
  })
})
