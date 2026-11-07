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
beforeEach(() => {
  vi.useFakeTimers()
  listeners = {}
  speak = vi.fn()
  vi.stubGlobal('document', {
    hidden: true,
    addEventListener: (name: string, fn: () => void) => { listeners[name] = fn },
    removeEventListener: vi.fn()
  })
  vi.stubGlobal('window', {
    speechSynthesis: { cancel: vi.fn(), speak, getVoices: () => [{ localService: true, lang: 'ru-RU' }] },
    addEventListener: vi.fn(), removeEventListener: vi.fn(),
    smartCursor: {
      voice: { onRecord: (fn: () => void) => { record = fn; return vi.fn() } },
      overlay: { onPreparing: () => vi.fn() },
      settings: { load: async () => ({ settings: { voice: { dialogue: true } } }) }
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
    expect(speak).toHaveBeenCalledOnce()
    expect(speak.mock.calls[0][0].text).toBe('Справа сверху.')
  })
  it('starts at the first complete sentence at 1.3x and never repeats it', async () => {
    const speech = useSpeech()
    speech.begin('one', 'Где настройки?', true)
    await speech.append('one', 'Справа')
    expect(speak).not.toHaveBeenCalled()
    await speech.append('one', ' сверху. Затем')
    expect(speak).toHaveBeenCalledOnce()
    expect(speak.mock.calls[0][0].rate).toBe(1.3)
    await speech.finish('one', 'Справа сверху. Затем откройте меню.')
    expect(speak.mock.calls.map(call => call[0].text)).toEqual(['Справа сверху.', 'Затем откройте меню.'])
  })
  it('waits for the verified result of an action', async () => {
    const speech = useSpeech()
    speech.begin('one', 'Открой настройки', true)
    await speech.append('one', 'Открываю настройки.')
    expect(speak).not.toHaveBeenCalled()
    await speech.finish('one', 'Готово.')
    expect(speak.mock.calls[0][0].text).toBe('Готово.')
  })
  it.each(['Где настройки?', 'Прочитай вслух'])('keeps typed requests silent until manual playback (%s)', async (prompt) => {
    const speech = useSpeech()
    speech.begin('one', prompt, false)
    await speech.append('one', 'Справа сверху.')
    await speech.finish('one', 'Справа сверху.')
    expect(speak).not.toHaveBeenCalled()
    speech.speak('Справа сверху.')
    expect(speak).toHaveBeenCalledOnce()
  })
  it('new recording cancels pending speech', async () => {
    const speech = useSpeech()
    speech.begin('one', 'Где настройки?', true)
    record()
    await speech.finish('one', 'Справа сверху.')
    expect(speak).not.toHaveBeenCalled()
  })
  it('cancellation during the settings read prevents stale playback', async () => {
    const speech = useSpeech()
    speech.begin('one', 'Где настройки?', true)
    const finished = speech.finish('one', 'Справа сверху.')
    speech.stop()
    await finished
    expect(speak).not.toHaveBeenCalled()
  })
})

afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals() })

describe('waiting acknowledgement', () => {
  it('speaks once after a delay and interrupts it for the answer', async () => {
    const speech = useSpeech()
    speech.begin('one', 'Объясни это', true)
    await vi.advanceTimersByTimeAsync(1499)
    expect(speak).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(speak.mock.calls[0][0].text).toBe('Сейчас посмотрю.')
    await speech.append('one', 'Вот ответ.')
    expect(window.speechSynthesis.cancel).toHaveBeenCalledTimes(2)
    expect(speak.mock.calls[1][0].text).toBe('Вот ответ.')
    await vi.advanceTimersByTimeAsync(30000)
    expect(speak).toHaveBeenCalledTimes(2)
  })
  it('never acknowledges a fast answer or a cancelled turn', async () => {
    const speech = useSpeech()
    speech.begin('one', 'Вопрос', true)
    await speech.finish('one', 'Ответ.')
    speech.begin('two', 'Другой вопрос', true)
    speech.stop()
    await vi.advanceTimersByTimeAsync(10000)
    expect(speak.mock.calls.map(call => call[0].text)).toEqual(['Ответ.'])
  })
  it('respects disabled dialogue and typed requests', async () => {
    window.smartCursor.settings.load = vi.fn().mockResolvedValue({ settings: { voice: { dialogue: false } } })
    const speech = useSpeech()
    speech.begin('one', 'Вопрос', true)
    await vi.advanceTimersByTimeAsync(2000)
    speech.begin('two', 'Прочитай вслух', false)
    await vi.advanceTimersByTimeAsync(2000)
    expect(speak).not.toHaveBeenCalled()
  })
  it('does not repeat an acknowledgement on the next quick turn', async () => {
    const speech = useSpeech()
    speech.begin('one', 'Вопрос', true)
    await vi.advanceTimersByTimeAsync(2000)
    await speech.finish('one', 'Ответ.')
    speech.begin('two', 'Ещё вопрос', true)
    await vi.advanceTimersByTimeAsync(2000)
    expect(speak.mock.calls.map(call => call[0].text)).toEqual(['Сейчас посмотрю.', 'Ответ.'])
  })
  it('rejects a delayed settings result after cancellation', async () => {
    let resolve!: (value: unknown) => void
    window.smartCursor.settings.load = vi.fn().mockImplementation(() => new Promise(r => { resolve = r }))
    const speech = useSpeech()
    speech.begin('one', 'Вопрос', true)
    await vi.advanceTimersByTimeAsync(2000)
    speech.stop()
    resolve({ settings: { voice: { dialogue: true } } })
    await Promise.resolve()
    await Promise.resolve()
    expect(speak).not.toHaveBeenCalled()
  })
})

describe('agent feedback independent of dialogue', () => {
  it.each([false, true])('acknowledges an action only when spoken with dialogue off (voice=%s)', async (voice) => {
    window.smartCursor.settings.load = vi.fn().mockResolvedValue({ settings: { voice: { dialogue: false, agentFeedback: true } } })
    const speech = useSpeech()
    speech.begin('one', 'Открой новую вкладку', voice)
    await vi.advanceTimersByTimeAsync(1500)
    await speech.finish('one', 'Готово.')
    expect(speak.mock.calls.map(call => call[0].text)).toEqual(voice ? ['Сейчас посмотрю.'] : [])
  })
  it('respects the separate feedback switch', async () => {
    window.smartCursor.settings.load = vi.fn().mockResolvedValue({ settings: { voice: { dialogue: true, agentFeedback: false } } })
    const speech = useSpeech()
    speech.begin('one', 'Открой новую вкладку', true)
    await vi.advanceTimersByTimeAsync(4000)
    expect(speak).not.toHaveBeenCalled()
  })
  it('waits for local voices to become available', async () => {
    const voices = vi.spyOn(window.speechSynthesis, 'getVoices').mockReturnValue([])
    const speech = useSpeech()
    speech.begin('one', 'Открой новую вкладку', true)
    await vi.advanceTimersByTimeAsync(1500)
    expect(speak).not.toHaveBeenCalled()
    voices.mockReturnValue([{ localService: true, lang: 'ru-RU' } as SpeechSynthesisVoice])
    await vi.advanceTimersByTimeAsync(200)
    expect(speak).toHaveBeenCalledOnce()
  })
})
