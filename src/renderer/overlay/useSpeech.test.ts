import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('react', () => ({
  useCallback: (fn: unknown) => fn,
  useRef: (current: unknown) => ({ current }),
  useState: (value: unknown) => [value, vi.fn()],
  useEffect: (effect: () => unknown) => effect()
}))
import { useSpeech } from './useSpeech'

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
    await speech.finish('one', 'Справа сверху. Затем откройте меню.')
    await flush()
    expect(speak.mock.calls.map(call => call[0].text)).toEqual(['Справа сверху.', 'Затем откройте меню.'])
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
