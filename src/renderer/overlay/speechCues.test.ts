/**
 * The rule that decides which states are spoken, and the rotation inside a state.
 *
 * Both halves exist because the bank alone is not a decision. A group per state
 * is easy to add and easy to leave unreachable — which is what happened to most
 * of it: 76 clips sat in the bundle for states nobody ever asked the voice
 * about. The gate below is the answer to "may this be said", and `speechLine` is
 * the answer to "which recording", so a new call site cannot invent either.
 */

import { describe, expect, it } from 'vitest'
import { SPEECH_BANK, type SpeechCue } from '@shared/speechBank'
import { speechLine, speaksCue, type SpeechGate } from './speechCues'

/** The default settings: agent feedback on, answers silent, typed request. */
const gate = (overrides: Partial<SpeechGate> = {}): SpeechGate => ({
  spoken: false,
  action: false,
  agentFeedback: true,
  answerVoice: 'off',
  ...overrides
})

describe('speaksCue: the microphone is always the channel', () => {
  it('speaks every microphone failure, whatever the settings say', () => {
    const silent = gate({ agentFeedback: false, answerVoice: 'off' })
    for (const cue of ['notHeard', 'recordFailed', 'transcribeFailed', 'noMic', 'recordTooLong'] as const) {
      expect(speaksCue(cue, silent), cue).toBe(true)
    }
  })
})

describe('speaksCue: feedback about the machine', () => {
  it('speaks the agent states when agent feedback is on', () => {
    for (const cue of ['approval', 'approved', 'denied', 'remembered', 'agentProgress'] as const) {
      expect(speaksCue(cue, gate()), cue).toBe(true)
    }
  })

  it('stays silent when agent feedback is off and the request was typed', () => {
    for (const cue of ['approval', 'approved', 'denied', 'remembered', 'agentProgress'] as const) {
      expect(speaksCue(cue, gate({ agentFeedback: false })), cue).toBe(false)
    }
  })

  it('still speaks them for a spoken request, where the card is not the channel', () => {
    expect(speaksCue('approval', gate({ spoken: true, agentFeedback: false }))).toBe(true)
  })
})

describe('speaksCue: how a turn ended', () => {
  it('speaks an action outcome as machine feedback', () => {
    expect(speaksCue('done', gate({ action: true }))).toBe(true)
    expect(speaksCue('done', gate({ action: true, agentFeedback: false }))).toBe(false)
  })

  it('speaks a written outcome only when answers are read aloud', () => {
    expect(speaksCue('failed', gate({ answerVoice: 'off' }))).toBe(false)
    expect(speaksCue('failed', gate({ answerVoice: 'system' }))).toBe(true)
    expect(speaksCue('textReady', gate({ answerVoice: 'neural' }))).toBe(true)
  })

  it('treats a spoken turn as its own channel', () => {
    expect(speaksCue('stopped', gate({ spoken: true }))).toBe(true)
  })
})

describe('speaksCue: a long wait', () => {
  it('is announced only to someone who asked out loud', () => {
    expect(speaksCue('longWait', gate({ spoken: true }))).toBe(true)
  })

  it('does not repeat the card for a typed question', () => {
    expect(speaksCue('longWait', gate({ answerVoice: 'system' }))).toBe(false)
  })
})

describe('speaksCue: what it refuses', () => {
  it('does not speak the acknowledgement, which has its own timer', () => {
    expect(speaksCue('acknowledge', gate({ spoken: true }))).toBe(false)
  })
})

describe('speechLine: rotation inside a state', () => {
  it('walks the whole group and then starts over', () => {
    const group = SPEECH_BANK.approval
    const seen = group.map((_, index) => speechLine('approval', index)?.id)
    expect(seen).toEqual(group.map((line) => line.id))
    expect(speechLine('approval', group.length)?.id).toBe(group[0].id)
  })

  it('never repeats the same line twice in a row while the group has several', () => {
    for (const cue of Object.keys(SPEECH_BANK) as SpeechCue[]) {
      const group = SPEECH_BANK[cue]
      if (group.length < 2) continue
      for (let index = 0; index < group.length * 3; index += 1) {
        expect(speechLine(cue, index)?.id, `${cue} at ${index}`)
          .not.toBe(speechLine(cue, index + 1)?.id)
      }
    }
  })

  it('is stable for a negative index, so a reset counter cannot throw', () => {
    expect(speechLine('done', -1)).toBeTruthy()
  })
})

describe('speechLine: the bank is what ships', () => {
  it('has a recording group for every cue the gate can allow', () => {
    const allowed: SpeechCue[] = [
      'notHeard', 'recordFailed', 'transcribeFailed', 'noMic', 'recordTooLong',
      'agentProgress', 'approval', 'approved', 'denied', 'remembered',
      'agentBlocked', 'secret', 'longWait', 'done', 'incomplete', 'failed',
      'stopped', 'timeout', 'textReady'
    ]
    for (const cue of allowed) {
      expect(SPEECH_BANK[cue].length, cue).toBeGreaterThan(0)
    }
  })
})
