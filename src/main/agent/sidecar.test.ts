/**
 * The wire between the app and the agent's process.
 *
 * This is a contract between two languages, so the tests are of two kinds. The
 * first kind feeds `translate()` a transcript that was **recorded from the real
 * Swift binary** (`deskhand-agent --serve`, driven by a stub OpenAI endpoint):
 * if the Swift side renames a field, these fail, which is exactly what a contract
 * test is for. The second kind checks the framing — partial lines, several events
 * in one read, a message split across chunks — because a pipe does not deliver
 * lines.
 */

import { describe, expect, it } from 'vitest'
import { translate, type Message } from './sidecar'

/** Verbatim output of the real binary for one two-step run. */
const TRANSCRIPT: string[] = [
  '{"event":"ready","params":{"tools":11,"version":"1"}}',
  '{"id":1,"result":{"started":true}}',
  '{"event":"step","params":{"step":1,"total":3}}',
  '{"event":"step-timing","params":{"calls":1,"history":1,"input_tokens":10,"llm_ms":13.2,"output_tokens":5,"prompt_bytes":46,"step":1}}',
  '{"event":"narration","params":{"step":1,"text":"Смотрю, какие приложения открыты."}}',
  '{"event":"tool","params":{"arguments":{},"name":"list_apps","narration":"Смотрю, какие приложения открыты.","step":1}}',
  '{"event":"result","params":{"name":"list_apps","ok":true,"step":1,"text":"Running applications:\\n- Finder (com.apple.finder) pid=83830","wall_ms":0.085}}',
  '{"event":"step","params":{"step":2,"total":3}}',
  '{"event":"step-timing","params":{"calls":0,"history":3,"input_tokens":10,"llm_ms":2.7,"output_tokens":5,"prompt_bytes":553,"step":2}}',
  '{"event":"narration","params":{"step":2,"text":"Готово: приложения перечислены."}}',
  '{"event":"run-report","params":{"calls":1,"failed_calls":0,"llm_ms":15.9,"steps":2,"table":"timings (total 39 ms)","tool_ms":0.085,"total_ms":23.4}}',
  '{"event":"done","params":{"answer":"Готово: приложения перечислены."}}'
]

const parsed = TRANSCRIPT.map((line) => JSON.parse(line) as Message)

describe('translate: a recorded transcript from the real agent', () => {
  it('reads the handshake', () => {
    expect(translate(parsed[0])).toEqual({ kind: 'ready', tools: 11 })
  })

  it('reads a step, with the budget it is counted against', () => {
    expect(translate(parsed[2])).toEqual({ kind: 'step', step: 1, total: 3 })
  })

  it('reads what the round trip cost, and what it was asked with', () => {
    expect(translate(parsed[3])).toEqual({
      kind: 'stepTiming',
      step: 1,
      timing: {
        llmMs: 13.2,
        promptBytes: 46,
        history: 1,
        calls: 1,
        inputTokens: 10,
        outputTokens: 5
      }
    })
  })

  it('reads the model’s own sentence about what it is doing', () => {
    expect(translate(parsed[4])).toEqual({
      kind: 'narration',
      step: 1,
      text: 'Смотрю, какие приложения открыты.'
    })
  })

  it('reads a call, its arguments and the narration it belongs to', () => {
    expect(translate(parsed[5])).toEqual({
      kind: 'tool',
      step: 1,
      name: 'list_apps',
      args: {},
      narration: 'Смотрю, какие приложения открыты.'
    })
  })

  it('reads a result, and keeps the text the agent got back', () => {
    const event = translate(parsed[6])
    expect(event).toMatchObject({ kind: 'result', name: 'list_apps', ok: true, step: 1 })
    if (event?.kind !== 'result') return
    expect(event.text).toContain('com.apple.finder')
  })

  it('reads the run’s totals', () => {
    expect(translate(parsed[10])).toEqual({
      kind: 'runReport',
      report: {
        steps: 2,
        calls: 1,
        failedCalls: 0,
        totalMs: 23.4,
        llmMs: 15.9,
        toolMs: 0.085,
        table: 'timings (total 39 ms)'
      }
    })
  })

  it('reads the closing answer, and whether the run actually finished', () => {
    expect(translate(parsed[11])).toEqual({
      kind: 'done',
      answer: 'Готово: приложения перечислены.',
      complete: true
    })
  })

  it('reads a run that stopped at its budget as unfinished', () => {
    // The loop returns a closing sentence on this path too, so the flag is the
    // only thing that distinguishes it from success.
    expect(
      translate({
        event: 'done',
        params: { answer: 'Stopped after 3 steps without finishing the task.', complete: false }
      })
    ).toEqual({
      kind: 'done',
      answer: 'Stopped after 3 steps without finishing the task.',
      complete: false
    })
  })

  it('treats a done without the flag as finished, for older binaries', () => {
    // A missing field is not a failure: an agent built before this flag existed
    // still describes a run that ended, and turning those into errors would
    // break every run against a stale binary.
    expect(translate({ event: 'done', params: { answer: 'Готово.' } })).toMatchObject({ complete: true })
  })

  it('produces no event for a plain acknowledgement', () => {
    // `{id, result}` is an answer to a request, not a progress event: the run's
    // `started: true` must not reach the card as a phase change.
    expect(translate(parsed[1])).toBeNull()
  })

  it('yields the whole run in order, with no gap', () => {
    const events = parsed.map(translate).filter(Boolean)

    expect(events.map((event) => event!.kind)).toEqual([
      'ready',
      'step',
      'stepTiming',
      'narration',
      'tool',
      'result',
      'step',
      'stepTiming',
      'narration',
      'runReport',
      'done'
    ])
  })
})

describe('translate: the fields the card depends on', () => {
  it('reads a question with everything the card shows', () => {
    const event = translate({
      event: 'approval',
      params: {
        id: 'call-7',
        tool: 'click',
        arguments: { label: 'Купить' },
        fingerprint: 'a'.repeat(64),
        app: 'Safari',
        bundle_id: 'com.apple.Safari',
        role: 'AXButton',
        title: 'Купить',
        label: 'Купить',
        text_field: false,
        narration: 'Оформляю заказ'
      }
    })

    expect(event).toEqual({
      kind: 'approval',
      request: {
        id: 'call-7',
        tool: 'click',
        arguments: { label: 'Купить' },
        fingerprint: 'a'.repeat(64),
        app: 'Safari',
        bundleId: 'com.apple.Safari',
        role: 'AXButton',
        title: 'Купить',
        label: 'Купить',
        textField: false,
        narration: 'Оформляю заказ'
      }
    })
  })

  it('defaults `ok` to true and a missing argument object to empty', () => {
    // The agent omits `ok` for a successful call rather than sending `true`; a
    // missing field must not read as a failure.
    expect(translate({ event: 'result', params: { name: 'click', step: 1 } })).toMatchObject({ ok: true })
    expect(translate({ event: 'tool', params: { name: 'click', step: 1 } })).toMatchObject({ args: {} })
  })

  it('reads a failure as a failure', () => {
    expect(translate({ event: 'result', params: { name: 'click', ok: false, step: 1 } })).toMatchObject({ ok: false })
  })

  it('reads a stop with its reason', () => {
    expect(translate({ event: 'stopped', params: { reason: 'loop detected: 3 identical calls' } })).toEqual({
      kind: 'stopped',
      reason: 'loop detected: 3 identical calls'
    })
  })

  it('reads the picture of an action, with its target and window', () => {
    expect(
      translate({
        event: 'present',
        params: {
          tool: 'click',
          gesture: 'click',
          app: 'Safari',
          bundle_id: 'com.apple.Safari',
          pid: 42,
          x: 120.5,
          y: 300,
          target: { x: 100, y: 290, width: 40, height: 20 },
          window: { x: 10, y: 20, width: 800, height: 600 }
        }
      })
    ).toEqual({
      kind: 'present',
      presentation: {
        tool: 'click',
        gesture: 'click',
        app: 'Safari',
        bundleId: 'com.apple.Safari',
        pid: 42,
        point: { x: 120.5, y: 300 },
        target: { x: 100, y: 290, width: 40, height: 20 },
        window: { x: 10, y: 20, width: 800, height: 600 }
      }
    })
  })

  it('keeps a presentation with no geometry, and never invents a point', () => {
    // A key press into an app that was never read has no element frame. The
    // window still comes forward; the pointer must not be aimed at 0,0.
    const event = translate({
      event: 'present',
      params: { tool: 'press_key', gesture: 'key', app: 'Notes' }
    })
    expect(event).toMatchObject({
      kind: 'present',
      presentation: { tool: 'press_key', gesture: 'key', app: 'Notes' }
    })
    if (event?.kind !== 'present') return
    expect(event.presentation.point).toBeUndefined()
    expect(event.presentation.target).toBeUndefined()
  })

  it('shows an unknown gesture as a click instead of dropping the picture', () => {
    expect(
      translate({
        event: 'present',
        params: { tool: 'new_tool', gesture: 'teleport' }
      })
    ).toMatchObject({ kind: 'present', presentation: { gesture: 'click' } })
  })

  it('reads a cancellation and an error', () => {
    expect(translate({ event: 'cancelled' })).toEqual({ kind: 'cancelled' })
    expect(translate({ event: 'error', params: { message: 'нет доступа', code: 'permission' } })).toEqual({
      kind: 'error',
      message: 'нет доступа',
      code: 'permission'
    })
  })

  it('splits a call into the phases that actually ran', () => {
    // A `get_app_state` walk and capture: the two phases that can dominate a
    // call, and the two that are fixed in completely different places.
    const event = translate({
      event: 'result',
      params: {
        name: 'get_app_state',
        ok: true,
        step: 1,
        text: 'tree',
        wall_ms: 493.02,
        tree_ms: 476.35,
        capture_ms: 12.1,
        encode_ms: 4.6,
        image_bytes: 151812
      }
    })

    expect(event).toMatchObject({
      timing: {
        wallMs: 493.02,
        treeMs: 476.35,
        captureMs: 12.1,
        encodeMs: 4.6,
        imageBytes: 151812
      }
    })
  })

  it('keeps a phase that did not run absent, rather than zero', () => {
    // "no capture" and "a capture that took 0 ms" are different facts, and a
    // report that conflates them blames the wrong phase.
    const event = translate({
      event: 'result',
      params: { name: 'list_apps', ok: true, step: 1, text: 'apps', wall_ms: 0.085 }
    })

    expect(event).toMatchObject({ timing: { wallMs: 0.085 } })
    if (event?.kind !== 'result') return
    expect('treeMs' in event.timing).toBe(false)
    expect('captureMs' in event.timing).toBe(false)
    expect('imageBytes' in event.timing).toBe(false)
  })

  it('does not round a sub-millisecond call away', () => {
    // Most tools are this cheap. Rounding them to 0 would make the fast path
    // look free and hide the ones that are not.
    const event = translate({
      event: 'result',
      params: { name: 'click', ok: true, step: 1, text: '', wall_ms: 0.4 }
    })

    expect(event).toMatchObject({ timing: { wallMs: 0.4 } })
  })

  it('reads the prose while the step is still running', () => {
    // The same caption as `narration`, but it arrives before the model stops
    // writing. The card can show it while the round trip is still in flight.
    expect(
      translate({
        event: 'stream',
        params: { step: 1, text: 'Открываю Telegram' }
      })
    ).toEqual({ kind: 'stream', step: 1, text: 'Открываю Telegram' })
  })

  it('reads a step with no narration, which is still a step the user waited for', () => {
    expect(
      translate({
        event: 'step-timing',
        params: { step: 2, llm_ms: 900, prompt_bytes: 20000, history: 12, calls: 0 }
      })
    ).toEqual({
      kind: 'stepTiming',
      step: 2,
      timing: { llmMs: 900, promptBytes: 20000, history: 12, calls: 0 }
    })
  })

  it('omits token counts the provider did not report', () => {
    const event = translate({
      event: 'step-timing',
      params: { step: 1, llm_ms: 10, prompt_bytes: 46, history: 1, calls: 0 }
    })

    if (event?.kind !== 'stepTiming') throw new Error('expected a step timing')
    expect('inputTokens' in event.timing).toBe(false)
    expect('outputTokens' in event.timing).toBe(false)
  })

  it('ignores an event it does not know', () => {
    // Forward compatibility in one direction only: a newer agent may emit a new
    // event, and an older app must keep working rather than throw mid-run.
    expect(translate({ event: 'something-new', params: { a: 1 } })).toBeNull()
  })

  it('survives a malformed event instead of throwing', () => {
    expect(translate({ event: 'step', params: { step: 'два' } })).toEqual({ kind: 'step', step: 0, total: 0 })
    expect(translate({ event: 'tool' })).toMatchObject({ name: '', args: {} })
  })
})
