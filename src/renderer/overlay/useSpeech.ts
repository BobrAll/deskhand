import { useCallback, useEffect, useRef, useState } from 'react'
import { WAIT_STATUS_MS, WAIT_VOICE_COOLDOWN_MS, waitingPhrases } from './waiting'
import { looksLikeAction } from '@shared/intent'
import { automaticSpeech, requestedReading, speechText } from './speech'

export function useSpeech() {
  const [speaking, setSpeaking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const generation = useRef(0)
  const turn = useRef<{ id: string; prompt: string; enabled: Promise<boolean>; buffer: string; spoken: string } | null>(null)
  const queued = useRef(0)
  const waitingTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const waitingVoice = useRef(false)
  const lastAcknowledgement = useRef(-Infinity)
  const phraseIndex = useRef(0)
  const clearWaiting = useCallback(() => {
    if (waitingTimer.current !== null) clearTimeout(waitingTimer.current)
    waitingTimer.current = null
    if (waitingVoice.current) {
      waitingVoice.current = false
      generation.current++
      queued.current = 0
      window.speechSynthesis?.cancel()
      setSpeaking(false)
    }
  }, [])
  const stop = useCallback(() => {
    clearWaiting()
    generation.current++
    turn.current = null
    queued.current = 0
    window.speechSynthesis?.cancel()
    setSpeaking(false)
  }, [clearWaiting])
  const enqueue = useCallback((text: string) => {
    setError(null)
    const clean = speechText(text)
    if (!clean) return
    const synth = window.speechSynthesis
    const language = /[а-яё]/i.test(clean) ? 'ru' : 'en'
    const voices = synth?.getVoices().filter(v => v.localService) ?? []
    const voice = voices.find(v => v.lang.toLowerCase().startsWith(language))
    if (!synth || !voice) {
      setError('Нет доступного системного голоса для этого языка. Добавьте голос в настройках macOS.')
      return
    }
    const token = generation.current
    const chunks = clean.match(/.{1,220}(?:\s|$)|\S{1,220}/g) ?? [clean]
    queued.current += chunks.length
    for (const chunk of chunks) {
      const utterance = new SpeechSynthesisUtterance(chunk)
      utterance.voice = voice
      utterance.lang = voice.lang
      utterance.rate = 1.3
      utterance.onend = () => {
        if (token !== generation.current) return
        queued.current--
        if (!queued.current) setSpeaking(false)
      }
      utterance.onerror = () => {
        if (token !== generation.current) return
        stop()
        setError('Не удалось озвучить ответ. Текст доступен в карточке.')
      }
      setSpeaking(true)
      synth.speak(utterance)
    }
  }, [stop])
  const speak = useCallback((text: string) => {
    stop()
    enqueue(text)
  }, [stop, enqueue])
  const begin = useCallback((id: string, prompt: string, voice: boolean) => {
    stop()
    setError(null)
    if (!voice) return
    // Read the preference while the model is thinking, not after its answer.
    const action = looksLikeAction(prompt)
    const preferences = window.smartCursor.settings.load().then(({ settings }) => settings.voice)
    const acknowledgement = preferences.then(settings => action
      ? settings.agentFeedback !== false : settings.dialogue).catch(() => false)
    const enabled = preferences
      .then(settings => requestedReading(prompt) || settings.dialogue)
      .catch(() => false)
    const current = { id, prompt, enabled, buffer: '', spoken: '' }
    turn.current = current
    // Acknowledgements are separate from reading the final answer aloud.
    let voiceAttempts = 0
    const acknowledge = async (): Promise<void> => {
      waitingTimer.current = null
      const token = generation.current
      if (!await acknowledgement || token !== generation.current || turn.current !== current) return
      if (current.spoken || Date.now() - lastAcknowledgement.current < WAIT_VOICE_COOLDOWN_MS) return
      const synth = window.speechSynthesis
      const local = synth?.getVoices().some(v => v.localService && v.lang.toLowerCase().startsWith('ru'))
      if (!local && voiceAttempts++ < 10) {
        // Chromium can populate voices after the first getVoices() call.
        waitingTimer.current = setTimeout(() => void acknowledge(), 200)
        return
      }
      if (!local) {
        setError('Для коротких реплик нужен русский системный голос. Добавьте его в настройках macOS и перезапустите Smart Cursor.')
        return
      }
      lastAcknowledgement.current = Date.now()
      waitingVoice.current = true
      enqueue(waitingPhrases[phraseIndex.current++ % waitingPhrases.length])
    }
    waitingTimer.current = setTimeout(() => void acknowledge(), WAIT_STATUS_MS)
  }, [stop, enqueue])
  const append = useCallback(async (id: string, delta: string) => {
    const current = turn.current
    if (!current || current.id !== id) return
    current.buffer += delta
    const token = generation.current
    if (!await current.enabled || token !== generation.current || turn.current !== current) return
    if (looksLikeAction(current.prompt)) return
    // Only complete sentences can be spoken; keep partial Markdown/code private.
    if (current.buffer.includes('```') || current.buffer.includes('|')) return
    const clean = speechText(current.buffer)
    const boundary = Math.max(clean.lastIndexOf('.'), clean.lastIndexOf('!'), clean.lastIndexOf('?'))
    if (boundary < 0) return
    const ready = automaticSpeech(current.prompt, clean.slice(0, boundary + 1))
    if (!ready.startsWith(current.spoken) || ready === 'Ответ готов. Подробности в карточке.') return
    const fresh = ready.slice(current.spoken.length).trim()
    current.spoken = ready
    if (fresh) {
      clearWaiting()
      enqueue(fresh)
    }
  }, [enqueue, clearWaiting])
  const finish = useCallback(async (id: string, text: string, failed = false) => {
    const current = turn.current
    if (!current || current.id !== id) return
    clearWaiting()
    const token = generation.current
    if (!await current.enabled || token !== generation.current || turn.current !== current) return
    clearWaiting()
    turn.current = null
    const spoken = automaticSpeech(current.prompt, text, failed)
    // Final text normally extends the streamed prefix. Never repeat that prefix.
    if (spoken.startsWith(current.spoken)) {
      const rest = spoken.slice(current.spoken.length).trim()
      if (rest) enqueue(rest)
    } else if (failed) {
      stop()
      enqueue(spoken)
    }
  }, [enqueue, stop, clearWaiting])
  useEffect(() => {
    const offRecord = window.smartCursor.voice.onRecord(stop)
    const offPreparing = window.smartCursor.overlay.onPreparing(stop)
    // Voice requests deliberately hide the card while the model works. Keep
    // the pending turn; hiding an already speaking card still stops playback.
    const visibility = (): void => {
      if (document.hidden && !turn.current) stop()
    }
    const key = (event: KeyboardEvent): void => { if (event.key === 'Escape') stop() }
    document.addEventListener('visibilitychange', visibility)
    window.addEventListener('keydown', key)
    // Trigger voice discovery before the first click.
    window.speechSynthesis?.getVoices()
    return () => {
      offRecord(); offPreparing(); stop()
      document.removeEventListener('visibilitychange', visibility)
      window.removeEventListener('keydown', key)
    }
  }, [stop])
  return { speaking, error, speak, stop, begin, append, finish }
}
