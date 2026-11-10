/**
 * Which state the assistant is allowed to say out loud, and which line it uses.
 *
 * The bank in `@shared/speechBank` has a group per state, but a group is not a
 * decision: the card already shows most of these states, and speaking them as
 * well turns a quiet assistant into one that narrates itself. The rule from
 * `docs/voice-phrases.md` is "не спорить с карточкой": speak where the card is
 * not the channel, stay silent where it is.
 *
 * Two channels exist, and they are not the same:
 *
 * - `agentFeedback` («Короткие реплики агента») is feedback about the machine —
 *   something is being pressed on the screen and the person is watching that,
 *   not the card. It is on by default and independent of whether answers are
 *   read aloud.
 * - `answerVoice` is whether the answer itself is read. When it is `off`, the
 *   card is where the answer lives, so the outcome is not spoken either.
 *
 * The microphone cues are the exception: by the time one is due the press is
 * over, the user is waiting to hear what was heard, and in dictation the card
 * may not be on screen at all.
 */

import { SPEECH_BANK, type SpeechCue, type SpeechLine } from '@shared/speechBank'
import type { AnswerVoice } from '@shared/types'

export interface SpeechGate {
  /** The request was spoken, so the card is not the channel. */
  spoken: boolean
  /** The request asks the machine to do something. */
  action: boolean
  /** «Короткие реплики агента». */
  agentFeedback: boolean
  /** «Голосом ответа». */
  answerVoice: AnswerVoice
}

/** A press just ended: the microphone is closed and the person is waiting. */
const MIC_CUES: ReadonlySet<SpeechCue> = new Set<SpeechCue>([
  'notHeard',
  'recordFailed',
  'transcribeFailed',
  'noMic',
  'recordTooLong'
])

/** The machine is working or asking: feedback about the screen, not the answer. */
const AGENT_CUES: ReadonlySet<SpeechCue> = new Set<SpeechCue>([
  'agentProgress',
  'approval',
  'approved',
  'denied',
  'remembered',
  'agentBlocked',
  'secret'
])

/** How a turn ended. Spoken only when something is already reading to the user. */
const OUTCOME_CUES: ReadonlySet<SpeechCue> = new Set<SpeechCue>([
  'done',
  'incomplete',
  'failed',
  'stopped',
  'timeout',
  'textReady'
])

export function speaksCue(cue: SpeechCue, gate: SpeechGate): boolean {
  if (MIC_CUES.has(cue)) return true
  if (cue === 'longWait') {
    // A2: the wait is only worth announcing to someone who asked out loud; a
    // typed question leaves the card on screen with the same sentence in it.
    return gate.spoken
  }
  if (AGENT_CUES.has(cue)) return gate.spoken || gate.agentFeedback
  if (OUTCOME_CUES.has(cue)) {
    // An action turn's outcome is machine feedback. A written turn's outcome is
    // the answer, and the answer is read only when the voice reads answers.
    return gate.spoken || (gate.action ? gate.agentFeedback : gate.answerVoice !== 'off')
  }
  // `acknowledge` is spoken by `begin` on its own timer, not through this gate.
  return false
}

/**
 * The line to say next for one state.
 *
 * `index` is a per-cue counter owned by the caller, so two states never consume
 * each other's rotation. Cycling the group means the same sentence cannot repeat
 * back to back while the group has more than one line — which is the whole point
 * of having several recordings for one state.
 */
export function speechLine(cue: SpeechCue, index: number): SpeechLine | null {
  const lines = SPEECH_BANK[cue]
  if (!lines || lines.length === 0) return null
  return lines[Math.abs(index) % lines.length]
}
