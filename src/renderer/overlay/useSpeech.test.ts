import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('react', () => ({
  useCallback: (fn: unknown) => fn,
  useRef: (current: unknown) => ({ current }),
  useState: (value: unknown) => [value, vi.fn()],
  useEffect: (effect: () => unknown) => effect()
}))
import { useSpeech } from './useSpeech'
import { TTS_MAX_CHARS } from '@shared/tts'

let listeners: Record<string, () => void>
let speak: ReturnType<typeof vi.fn>
let record: () => void

/**
 * Playback is queued now: a line is fetched (from disk or the engine) and only
 * then handed to an audio element, so one flush of microtasks separates "the
 * answer arrived" from "the first sound started". Nothing here depends on wall
 * clock time, only on promise ordering.
 */
async function flush(times = 12): Promise<void> {
  for (let i = 0; i < times; i += 1) await Promise.resolve()
}

beforeEach(() => {
  vi.useFakeTimers()
  listeners = {}
  // The system voice reports completion through the utterance, and the queue
  // waits for it: without an `onend` the second line would never start.
  speak = vi.fn((utterance: { onend?: () => void }) => {
    queueMicrotask(() => utterance.onend?.())
  })
  vi.stubGlobal('document', {
    hidden: true,
    addEventListener: (name: string, fn: () => void) => { listeners[name] = fn },
    removeEventListener: vi.fn()
  })
  vi.stubGlobal('window', {
    speechSynthesis: { cancel: vi.fn(), speak, getVoices: () => [{ localService: true, lang: 'ru-RU' }] },
    addEventListener: vi.fn(), removeEventListener: vi.fn(),
    deskhand: {
      voice: { onRecord: (fn: () => void) => { record = fn; return vi.fn() } },
      overlay: { onPreparing: () => vi.fn() },
      // No neural voice in these tests: the system voice is the last fallback,
      // which is what the assertions below can observe.
      tts: { speak: async () => ({ ok: false, message: 'нет' }) },
      settings: { load: async () => ({ settings: { voice: { answerVoice: 'system' } } }) }
    }
  })
  vi.stubGlobal('SpeechSynthesisUtterance', class { constructor(public text: string) {} })
})

describe('automatic speech lifecycle', () => {
  it('survives the card hiding while a voice answer is being generated', async () => {
    const speech = useSpeech()
    speech.begin('one', 'Где настройки?', true)
    listeners.visibilitychange()
    await speech.finish('one', 'Справа сверху.')
    await flush()
    expect(speak).toHaveBeenCalledOnce()
    expect(speak.mock.calls[0][0].text).toBe('Справа сверху.')
  })
  it('starts at the first complete sentence at 1.3x and never repeats it', async () => {
    const speech = useSpeech()
    speech.begin('one', 'Где настройки?', true)
    await speech.append('one', 'Справа')
    await flush()
    expect(speak).not.toHaveBeenCalled()
    await speech.append('one', ' сверху. Затем')
    await flush()
    expect(speak).toHaveBeenCalledOnce()
    expect(speak.mock.calls[0][0].rate).toBe(1.3)
    await speech.finish('one', 'Справа сверху. Затем открой меню.')
    await flush()
    expect(speak.mock.calls.map(call => call[0].text)).toEqual(['Справа сверху.', 'Затем открой меню.'])
  })
  it('waits for the verified result of an action', async () => {
    const speech = useSpeech()
    speech.begin('one', 'Открой настройки', true)
    await speech.append('one', 'Открываю настройки.')
    await flush()
    expect(speak).not.toHaveBeenCalled()
    await speech.finish('one', 'Готово.')
    await flush()
    expect(speak.mock.calls[0][0].text).toBe('Готово.')
  })
  it.each(['Где настройки?', 'Прочитай вслух'])('keeps typed requests silent until manual playback (%s)', async (prompt) => {
    const speech = useSpeech()
    speech.begin('one', prompt, false)
    await speech.append('one', 'Справа сверху.')
    await speech.finish('one', 'Справа сверху.')
    await flush()
    expect(speak).not.toHaveBeenCalled()
    speech.speak('Справа сверху.')
    await flush()
    expect(speak).toHaveBeenCalledOnce()
  })
  it('new recording cancels pending speech', async () => {
    const speech = useSpeech()
    speech.begin('one', 'Где настройки?', true)
    record()
    await speech.finish('one', 'Справа сверху.')
    await flush()
    expect(speak).not.toHaveBeenCalled()
  })
  it('cancellation during the settings read prevents stale playback', async () => {
    const speech = useSpeech()
    speech.begin('one', 'Где настройки?', true)
    const finished = speech.finish('one', 'Справа сверху.')
    speech.stop()
    await finished
    await flush()
    expect(speak).not.toHaveBeenCalled()
  })
})

afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals() })

describe('manual playback', () => {
  it('uses macOS for manual playback even if a neural engine is still configured', async () => {
    const synth = vi.fn(async () => ({ ok: true as const, audio: 'AAA', cached: false, mime: 'audio/wav' }))
    window.deskhand.tts.speak = synth
    useSpeech().speak('Ответ.')
    await flush()
    expect(synth).not.toHaveBeenCalled()
    expect(speak.mock.calls[0][0].text).toBe('Ответ.')
  })

  it('uses the configured synthesizer and plays every fragment of a long answer in order', async () => {
    window.deskhand.settings.load = vi.fn().mockResolvedValue({
      settings: { voice: { answerVoice: 'neural' } }
    })
    const synth = vi.fn(async (_text: string) => ({
      ok: true as const, audio: 'AAA', cached: false, mime: 'audio/wav'
    }))
    window.deskhand.tts.speak = synth
    const clips: Array<{ onended: (() => void) | null }> = []
    vi.stubGlobal('Audio', class {
      onended: (() => void) | null = null
      constructor(public url: string) { clips.push(this) }
      async play(): Promise<void> {}
    })

    const answer = 'Первый абзац. '.repeat(60) + 'Второй абзац. '.repeat(60) + 'Последнее предложение.'
    useSpeech().speak(answer)
    await flush()
    expect(clips).toHaveLength(1)
    expect(synth).toHaveBeenCalledOnce()
    for (let i = 0; i < 3; i++) {
      clips[i].onended?.()
      await flush()
    }
    expect(clips).toHaveLength(3)
    const fragments = synth.mock.calls.map(([text]) => text)
    expect(fragments.every(text => text.length <= TTS_MAX_CHARS)).toBe(true)
    expect(fragments.join(' ')).toBe(answer)
    expect(speak).not.toHaveBeenCalled()
  })

  it('waits for each system utterance before starting the next one', async () => {
    speak.mockImplementation(() => undefined)
    const answer = 'Длинный ответ. '.repeat(20) + 'Конец.'
    useSpeech().speak(answer)
    await flush()
    expect(speak).toHaveBeenCalledOnce()
    speak.mock.calls[0][0].onend()
    await flush()
    expect(speak).toHaveBeenCalledTimes(2)
    expect(speak.mock.calls.map(([utterance]) => utterance.text).join(' ')).toBe(answer)
  })
})

describe('waiting acknowledgement', () => {
  it('speaks once after a delay and interrupts it for the answer', async () => {
    const speech = useSpeech()
    speech.begin('one', 'Объясни это', true)
    await vi.advanceTimersByTimeAsync(1499)
    await flush()
    expect(speak).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await flush()
    expect(speak.mock.calls[0][0].text).toBe('Сейчас посмотрю.')
    await speech.append('one', 'Вот ответ.')
    await flush()
    expect(window.speechSynthesis.cancel).toHaveBeenCalledTimes(2)
    expect(speak.mock.calls[1][0].text).toBe('Вот ответ.')
    await vi.advanceTimersByTimeAsync(30000)
    await flush()
    expect(speak).toHaveBeenCalledTimes(2)
  })
  it('never acknowledges a fast answer', async () => {
    const speech = useSpeech()
    speech.begin('one', 'Вопрос', true)
    await speech.finish('one', 'Ответ.')
    await flush()
    expect(speak.mock.calls.map(call => call[0].text)).toEqual(['Ответ.'])
  })
  it('never acknowledges a cancelled turn', async () => {
    const speech = useSpeech()
    speech.begin('one', 'Вопрос', true)
    speech.stop()
    await vi.advanceTimersByTimeAsync(10000)
    await flush()
    expect(speak).not.toHaveBeenCalled()
  })
  it('respects an unspoken answer and typed requests', async () => {
    window.deskhand.settings.load = vi.fn().mockResolvedValue({ settings: { voice: { answerVoice: 'off' } } })
    const speech = useSpeech()
    speech.begin('one', 'Вопрос', true)
    await vi.advanceTimersByTimeAsync(2000)
    speech.begin('two', 'Прочитай вслух', false)
    await vi.advanceTimersByTimeAsync(2000)
    await flush()
    expect(speak).not.toHaveBeenCalled()
  })
  it('does not repeat an acknowledgement on the next quick turn', async () => {
    const speech = useSpeech()
    speech.begin('one', 'Вопрос', true)
    await vi.advanceTimersByTimeAsync(2000)
    await flush()
    await speech.finish('one', 'Ответ.')
    await flush()
    speech.begin('two', 'Ещё вопрос', true)
    await vi.advanceTimersByTimeAsync(2000)
    await flush()
    expect(speak.mock.calls.map(call => call[0].text)).toEqual(['Сейчас посмотрю.', 'Ответ.'])
  })
  it('rejects a delayed settings result after cancellation', async () => {
    let resolve!: (value: unknown) => void
    window.deskhand.settings.load = vi.fn().mockImplementation(() => new Promise(r => { resolve = r }))
    const speech = useSpeech()
    speech.begin('one', 'Вопрос', true)
    await vi.advanceTimersByTimeAsync(2000)
    speech.stop()
    resolve({ settings: { voice: { answerVoice: 'system' } } })
    await flush()
    expect(speak).not.toHaveBeenCalled()
  })
})

describe('the local engine', () => {
  beforeEach(() => {
    window.deskhand.settings.load = vi.fn().mockResolvedValue({
      settings: { voice: { answerVoice: 'neural' } }
    })
  })

  const tts = (): { speak: typeof window.deskhand.tts.speak; status: typeof window.deskhand.tts.status } =>
    window.deskhand.tts

  /** A configured Silero engine: free and offline, so it reads the bank's lines too. */
  function localEngine(): ReturnType<typeof vi.fn> {
    const synth = vi.fn(async () => ({ ok: true as const, audio: 'AAA', cached: false, mime: 'audio/wav' }))
    tts().speak = synth
    tts().status = vi.fn(async () => ({ configured: true, engine: 'silero' } as Awaited<ReturnType<typeof window.deskhand.tts.status>>))
    return synth
  }

  it('speaks a recorded cue in the chosen voice instead of the bank', async () => {
    const synth = localEngine()
    const speech = useSpeech()
    speech.begin('one', 'Открой новую вкладку', true)
    await vi.advanceTimersByTimeAsync(1500)
    await flush()
    // «Сейчас посмотрю.» is in the bank; the local voice replaces it, because it
    // is the voice the user picked and it costs nothing to synthesise.
    expect(synth).toHaveBeenCalledWith('Сейчас посмотрю.', true)
  })

  it('falls back to the recorded line when the engine refuses', async () => {
    tts().speak = vi.fn(async () => ({ ok: false as const, message: 'нет' }))
    tts().status = vi.fn(async () => ({ configured: true, engine: 'silero' } as Awaited<ReturnType<typeof window.deskhand.tts.status>>))
    const speech = useSpeech()
    speech.begin('one', 'Открой новую вкладку', true)
    await vi.advanceTimersByTimeAsync(1500)
    await flush()
    expect(speak.mock.calls[0][0].text).toBe('Сейчас посмотрю.')
  })

  it('keeps the recorded bank when the engine is remote', async () => {
    const synth = vi.fn(async () => ({ ok: true as const, audio: 'AAA', cached: false, mime: 'audio/mpeg' }))
    tts().speak = synth
    tts().status = vi.fn(async () => ({ configured: true, engine: 'remote' } as Awaited<ReturnType<typeof window.deskhand.tts.status>>))
    const speech = useSpeech()
    speech.begin('one', 'Открой новую вкладку', true)
    await vi.advanceTimersByTimeAsync(1500)
    await flush()
    expect(synth).not.toHaveBeenCalled()
    expect(speak.mock.calls[0][0].text).toBe('Сейчас посмотрю.')
  })
})

describe('agent feedback independent of the answer voice', () => {
  it.each([false, true])('acknowledges an action only when it was spoken (voice=%s)', async (voice) => {
    window.deskhand.settings.load = vi.fn().mockResolvedValue({ settings: { voice: { answerVoice: 'off', agentFeedback: true } } })
    const speech = useSpeech()
    speech.begin('one', 'Открой новую вкладку', voice)
    await vi.advanceTimersByTimeAsync(1500)
    await speech.finish('one', 'Готово.')
    await flush()
    expect(speak.mock.calls.map(call => call[0].text)).toEqual(voice ? ['Сейчас посмотрю.'] : [])
  })
  it('respects the separate feedback switch', async () => {
    window.deskhand.settings.load = vi.fn().mockResolvedValue({ settings: { voice: { answerVoice: 'system', agentFeedback: false } } })
    const speech = useSpeech()
    speech.begin('one', 'Открой новую вкладку', true)
    await vi.advanceTimersByTimeAsync(4000)
    await flush()
    expect(speak).not.toHaveBeenCalled()
  })
  it('waits for local voices to become available', async () => {
    const voices = vi.spyOn(window.speechSynthesis, 'getVoices').mockReturnValue([])
    const speech = useSpeech()
    speech.begin('one', 'Открой новую вкладку', true)
    await vi.advanceTimersByTimeAsync(1500)
    await flush()
    expect(speak).not.toHaveBeenCalled()
    voices.mockReturnValue([{ localService: true, lang: 'ru-RU' } as SpeechSynthesisVoice])
    await vi.advanceTimersByTimeAsync(200)
    await flush()
    expect(speak).toHaveBeenCalledOnce()
  })
})

describe('say: the recorded line for a state', () => {
  it('speaks the line for the state when the settings allow it', async () => {
    const speech = useSpeech()
    speech.say('done', { action: true })
    await flush()
    expect(speak.mock.calls[0][0].text).toBe('Готово.')
  })

  it('rotates inside the group instead of repeating one line', async () => {
    const speech = useSpeech()
    speech.say('done', { action: true })
    await flush()
    speech.say('done', { action: true })
    await flush()
    const spoken = speak.mock.calls.map((call) => call[0].text)
    expect(spoken).toHaveLength(2)
    expect(spoken[0]).not.toBe(spoken[1])
  })

  it('keeps a written outcome silent while answers are not read aloud', async () => {
    window.deskhand.settings.load = vi.fn().mockResolvedValue({
      settings: { voice: { answerVoice: 'off', agentFeedback: true } }
    })
    const speech = useSpeech()
    speech.say('failed', { action: false })
    await flush()
    expect(speak).not.toHaveBeenCalled()
  })

  it('still speaks an action outcome with the same settings', async () => {
    window.deskhand.settings.load = vi.fn().mockResolvedValue({
      settings: { voice: { answerVoice: 'off', agentFeedback: true } }
    })
    const speech = useSpeech()
    speech.say('done', { action: true })
    await flush()
    expect(speak).toHaveBeenCalledOnce()
  })

  it('says nothing when the cue is not one the voice owns', async () => {
    const speech = useSpeech()
    speech.say('acknowledge', { spoken: true })
    await flush()
    expect(speak).not.toHaveBeenCalled()
  })
})

describe('say: an answer that cannot be read', () => {
  it('speaks a rotating "answer is ready" line instead of the text', async () => {
    const speech = useSpeech()
    speech.begin('one', 'Объясни это', true)
    await speech.finish('one', '```js\nconsole.log(1)\n```')
    await flush()
    expect(speak).toHaveBeenCalledOnce()
    expect(speak.mock.calls[0][0].text).toMatch(/^Ответ готов\.$/)
  })
})
