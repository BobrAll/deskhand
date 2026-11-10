import { describe, expect, it } from 'vitest'
import { speechLines } from '@shared/speechBank'
import { phraseAudio, recordedLineCount, staleLines } from './speechAudio'

describe('recorded lines', () => {
  it('has a clip for every line in the bank', () => {
    // A line added to the bank without rendering is silent in production and
    // only shows up as "the assistant stopped talking", which is hard to trace.
    // A line *reworded* is worse: without the manifest it would keep playing the
    // old recording, so the audio and the card would disagree. Both failures
    // land here, with the ids that need rendering again.
    expect(staleLines()).toEqual([])
    expect(recordedLineCount()).toBe(speechLines().length)
  })

  it('finds a line regardless of case and trailing punctuation', () => {
    expect(phraseAudio('Готово.')).toBeTruthy()
    expect(phraseAudio('готово')).toBe(phraseAudio('Готово.'))
    expect(phraseAudio('  Готово  ')).toBe(phraseAudio('Готово.'))
  })

  it('never substitutes a different sentence', () => {
    // The lookup is by text, so a near-miss must not borrow another line's
    // audio: the answer would be spoken with words the model did not say.
    expect(phraseAudio('Готово, но не совсем')).toBeNull()
    expect(phraseAudio('Справа сверху.')).toBeNull()
  })
})
