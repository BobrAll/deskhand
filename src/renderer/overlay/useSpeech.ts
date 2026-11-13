import { useCallback, useEffect, useRef, useState } from 'react'
import { WAIT_STATUS_MS, waitingPhrases } from './waiting'
import { looksLikeAction } from '@shared/intent'
import type { AnswerVoice, VoiceSettings } from '@shared/types'
import type { SpeechCue } from '@shared/speechBank'
import { TTS_MAX_CHARS } from '@shared/tts'
import { speechLine, speaksCue } from './speechCues'
import {
  ANSWER_FALLBACK,
  SPEECH_COOLDOWN_MS,
  automaticSpeech,
  requestedReading,
  speechText
} from './speech'
import { phraseAudio } from './speechAudio'

/**
 * The card's voice.
 *
 * Three sources, in order of cost. A line the assistant says about its own state
 * is a recording shipped with the app, so it starts instantly and costs nothing.
 * A line that is not recorded — normally the answer — is synthesised by the main
 * process and cached there, but only when the user has configured a voice and
 * chosen it for answers; otherwise it is spoken by the macOS voice, or not at
 * all when answers are set to stay silent. Manual playback uses the configured
 * synthesizer with the macOS voice as fallback.
 *
 * Ordering is a promise chain rather than a counter: clips become ready at
 * different times (one now from disk, one after a round trip), and the second
 * must still start when the first ends, not when its own request happens to
 * finish.
 */

/** Chromium can populate the voice list a frame or two after the first call. */
const VOICE_RETRY_MS = 200
const VOICE_RETRIES = 10

/** The system voice is fed the answer in chunks of at most this many characters. */
const SPEECH_CHUNK_CHARS = 220
/** Faster than the macOS default, which reads slower than a person scans the card. */
const SPEECH_RATE = 1.3

function* speechChunks(text: string, limit: number): Generator<string> {
  let remaining = text
  while (remaining.length > limit) {
    let end = remaining.lastIndexOf(' ', limit)
    if (end < 1) {
      end = limit
      const next = remaining.charCodeAt(end)
      if (next >= 0xdc00 && next <= 0xdfff) end--
    }
    yield remaining.slice(0, end)
    remaining = remaining.slice(end).trimStart()
  }
  if (remaining) yield remaining
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** A synthesised line, or null when the live engine is unavailable. */
async function synthesize(text: string, localOnly = false): Promise<string | null> {
  const api = window.deskhand?.tts
  if (!api) return null
  try {
    const result = await (localOnly ? api.speak(text, true) : api.speak(text))
    return result.ok && result.audio
      ? `data:${result.mime || 'audio/mpeg'};base64,${result.audio}`
      : null
  } catch {
    return null
  }
}

/** The voice preferences a turn reads once, and what they mean for playback. */
interface VoiceSettingsRead {
  voice: VoiceSettings
  /** The configured engine is the local one and has everything it needs. */
  local: boolean
}

/**
 * Reads the voice settings and the engine state behind them.
 *
 * One round trip per turn, not per line: `say` and `prepare` ask the same
 * question many times while a single answer is read.
 */
async function readVoice(): Promise<VoiceSettingsRead | null> {
  try {
    const { settings } = await window.deskhand.settings.load()
    const api = window.deskhand.tts
    const status = typeof api?.status === 'function' ? await api.status().catch(() => null) : null
    return {
      voice: settings.voice,
      local: settings.voice.answerVoice === 'neural' && status?.configured === true && status.engine === 'silero'
    }
  } catch {
    return null
  }
}

export function useSpeech() {
  const [speaking, setSpeaking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const generation = useRef(0)
  const turn = useRef<{ id: string; prompt: string; enabled: Promise<boolean>; buffer: string; spoken: string } | null>(null)
  /** Serial playback: the next clip starts when the previous one ends. */
  const chain = useRef<Promise<void>>(Promise.resolve())
  const audio = useRef<HTMLAudioElement | null>(null)
  /** Resolves the promise a paused clip is holding open. */
  const releaseAudio = useRef<(() => void) | null>(null)
  const releaseSystem = useRef<(() => void) | null>(null)
  const playing = useRef(0)
  const waitingTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const waitingVoice = useRef(false)
  const lastAcknowledgement = useRef(-Infinity)
  const phraseIndex = useRef(0)
  /**
   * Rotation position per state, so two cues never consume each other's.
   *
   * A state with several recordings is meant to sound different each time it
   * happens; one counter shared by every state would let "Готово." eat the turn
   * of "Не получилось." and repeat the same line back to back.
   */
  const cueIndex = useRef<Partial<Record<SpeechCue, number>>>({})
  /**
   * The voice settings, read once per turn rather than once per line.
   *
   * `say` is called at state transitions, some of which arrive several times a
   * run; asking the main process for the settings each time would be a round
   * trip per spoken word.
   */
  const voiceSettings = useRef<Promise<VoiceSettingsRead | null> | null>(null)
  /**
   * Whether new lines may go to the live engine.
   *
   * True only when the answer voice is set to `neural`. The recorded bank is
   * tried first regardless, so a configured voice never turns a free line into a
   * paid one by accident.
   */
  const liveAllowed = useRef(false)
  /**
   * Whether the configured engine is the local one, and ready.
   *
   * A local voice is free and offline, so it may read the recorded bank's lines
   * too — that is what makes the chosen local voice the voice of the whole
   * assistant instead of only of long answers. The remote engine does not get
   * that: a recorded line is a line nobody pays for.
   */
  const localVoice = useRef(false)

  /** Cuts off everything that is playing and invalidates queued work. */
  const silence = useCallback(() => {
    chain.current = Promise.resolve()
    const element = audio.current
    audio.current = null
    releaseAudio.current?.()
    releaseAudio.current = null
    if (element) {
      element.pause()
      element.removeAttribute('src')
    }
    releaseSystem.current?.()
    window.speechSynthesis?.cancel()
    playing.current = 0
    setSpeaking(false)
  }, [])

  const clearWaiting = useCallback(() => {
    if (waitingTimer.current !== null) clearTimeout(waitingTimer.current)
    waitingTimer.current = null
    if (!waitingVoice.current) return
    waitingVoice.current = false
    generation.current++
    silence()
  }, [silence])

  const stop = useCallback(() => {
    clearWaiting()
    generation.current++
    turn.current = null
    voiceSettings.current = null
    liveAllowed.current = false
    localVoice.current = false
    silence()
  }, [clearWaiting, silence])

  /**
   * Plays one audio URL, resolving when it ends.
   *
   * `false` means "this source cannot be played here" — no `Audio` in the test
   * runner, a blocked autoplay, a decoder failure — and the caller falls back.
   * It is not an error the user should see: the system voice still works.
   */
  const playAudio = useCallback((url: string): Promise<boolean> => {
    if (!url || typeof Audio === 'undefined') return Promise.resolve(false)
    return new Promise<boolean>((resolve) => {
      const element = new Audio(url)
      audio.current = element
      const settle = (played: boolean): void => {
        if (audio.current === element) {
          audio.current = null
          releaseAudio.current = null
        }
        element.onended = null
        element.onerror = null
        resolve(played)
      }
      releaseAudio.current = () => settle(false)
      element.onended = () => settle(true)
      element.onerror = () => settle(false)
      void element.play().catch(() => settle(false))
    })
  }, [])

  /** Feed macOS one utterance at a time and wait for it to finish. */
  const playSystem = useCallback(async (clean: string, token: number): Promise<void> => {
    const synth = window.speechSynthesis
    const language = /[а-яё]/i.test(clean) ? 'ru' : 'en'
    const pick = (): SpeechSynthesisVoice | undefined =>
      synth?.getVoices().filter(v => v.localService).find(v => v.lang.toLowerCase().startsWith(language))

    let voice = pick()
    for (let attempt = 0; !voice && attempt < VOICE_RETRIES; attempt++) {
      await sleep(VOICE_RETRY_MS)
      if (token !== generation.current) return
      voice = pick()
    }
    if (!synth || !voice) {
      setError('Нет доступного системного голоса для этого языка. Добавь голос в настройках macOS.')
      return
    }

    for (const chunk of speechChunks(clean, SPEECH_CHUNK_CHARS)) {
      if (token !== generation.current) return
      await new Promise<void>((resolve) => {
        const utterance = new SpeechSynthesisUtterance(chunk)
        utterance.voice = voice
        utterance.lang = voice.lang
        utterance.rate = SPEECH_RATE
        const settle = (): void => {
          utterance.onend = null
          utterance.onerror = null
          releaseSystem.current = null
          resolve()
        }
        releaseSystem.current = settle
        utterance.onend = settle
        utterance.onerror = () => {
          if (token === generation.current) setError('Не удалось озвучить ответ. Текст доступен в карточке.')
          settle()
        }
        synth.speak(utterance)
      })
    }
  }, [])

  /** Silero can voice cues itself; the remote engine uses the recording. */
  const prepareCue = useCallback(async (clean: string): Promise<string> => {
    const recorded = phraseAudio(clean)
    if (localVoice.current) {
      // The chosen local voice reads this line, and the recording stays as the
      // fallback for an engine that fails mid-answer.
      return (await synthesize(clean, true)) ?? recorded ?? ''
    }
    if (recorded) return recorded
    return liveAllowed.current ? (await synthesize(clean)) ?? '' : ''
  }, [])

  /** Prepare the first clip while earlier lines play. Request later clips as playback advances. */
  const enqueue = useCallback((text: string, kind: 'cue' | 'answer' | 'manual' = 'cue') => {
    setError(null)
    const clean = speechText(text)
    if (!clean) return
    const token = generation.current
    const live = kind === 'manual' || (kind === 'answer' && liveAllowed.current)
    const chunks = live ? speechChunks(clean, TTS_MAX_CHARS) : [clean].values()
    const prepare = async (chunk: string): Promise<string> => {
      if (kind === 'cue') return prepareCue(chunk)
      return live ? (await synthesize(chunk)) ?? '' : ''
    }
    const first = chunks.next()
    if (first.done) return
    const prepared = prepare(first.value)
    chain.current = chain.current.then(async () => {
      if (token !== generation.current) return
      playing.current += 1
      setSpeaking(true)
      try {
        let source = prepared
        for (let chunk = first.value; ; ) {
          const url = await source
          if (token !== generation.current) return
          const played = await playAudio(url)
          if (!played && token === generation.current) await playSystem(chunk, token)
          if (token !== generation.current) return
          const next = chunks.next()
          if (next.done) break
          chunk = next.value
          source = prepare(chunk)
        }
      } finally {
        if (token === generation.current) {
          playing.current = Math.max(0, playing.current - 1)
          if (playing.current === 0) setSpeaking(false)
        }
      }
    }).catch(() => undefined)
  }, [prepareCue, playAudio, playSystem])

  /**
   * Says one line for a state, if that state is one worth saying.
   *
   * The decision is `speaksCue` — a pure function, tested on its own — so the
   * callers only have to say what happened: which cue, whether the request was
   * spoken, and whether it asked the machine to do something. Whether the
   * settings allow it is read here, in one place, rather than at every call site.
   */
  const say = useCallback(
    (cue: SpeechCue, context: { spoken?: boolean; action?: boolean } = {}) => {
      const token = generation.current
      voiceSettings.current ??= readVoice()
      void voiceSettings.current.then((read) => {
        if (!read || token !== generation.current) return
        localVoice.current = read.local
        const voice = read.voice
        const allowed = speaksCue(cue, {
          spoken: context.spoken === true,
          action: context.action === true,
          agentFeedback: voice.agentFeedback !== false,
          answerVoice: voice.answerVoice ?? 'off'
        })
        if (!allowed) return
        const index = cueIndex.current[cue] ?? 0
        cueIndex.current[cue] = index + 1
        const line = speechLine(cue, index)
        if (line) enqueue(line.text)
      })
    },
    [enqueue]
  )

  const speak = useCallback((text: string) => {
    stop()
    const token = generation.current
    void readVoice().then((read) => {
      if (token !== generation.current) return
      enqueue(text, read?.voice.answerVoice === 'system' ? 'answer' : 'manual')
    })
  }, [stop, enqueue])

  const begin = useCallback((id: string, prompt: string, spoken: boolean) => {
    stop()
    setError(null)
    if (!spoken) return
    // Read the preference while the model is thinking, not after its answer.
    const action = looksLikeAction(prompt)
    const preferences = readVoice()
    // `say` reads the same settings; caching this read saves a round trip per
    // cue, and a turn is exactly when they can have changed.
    voiceSettings.current = preferences
    // `off` means the answer is read on the card, not heard. A recorded line is
    // still spoken for an action, because that is feedback about the machine,
    // not a repeat of text the user can already see. An absent value is treated
    // as off: speech is opt-in, never a guess.
    const speaksAnswer = (mode: AnswerVoice | undefined): boolean =>
      mode === 'system' || mode === 'neural'
    const acknowledgement = preferences.then(read => read !== null && (action
      ? read.voice.agentFeedback !== false
      : speaksAnswer(read.voice.answerVoice))).catch(() => false)
    const enabled = preferences
      .then(read => read !== null &&
        (requestedReading(prompt) || speaksAnswer(read.voice.answerVoice)))
      .catch(() => false)
    const current = { id, prompt, enabled, buffer: '', spoken: '' }
    turn.current = current
    // `liveAllowed` and `localVoice` are read when a line is queued, so they have
    // to be settled before the first one. Not awaited: a line that arrives
    // sooner is a recorded one, and those never need the engine.
    void preferences
      .then((read) => {
        if (voiceSettings.current !== preferences) return
        liveAllowed.current = read?.voice.answerVoice === 'neural' ||
          (read?.voice.answerVoice === 'off' && requestedReading(prompt))
        localVoice.current = read?.local === true
      })
      .catch(() => {
        liveAllowed.current = false
        localVoice.current = false
      })
    // Acknowledgements are separate from reading the final answer aloud.
    const acknowledge = async (): Promise<void> => {
      waitingTimer.current = null
      const token = generation.current
      if (!await acknowledgement || token !== generation.current || turn.current !== current) return
      if (current.spoken || Date.now() - lastAcknowledgement.current < SPEECH_COOLDOWN_MS) return
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
    if (!ready.startsWith(current.spoken) || ready === ANSWER_FALLBACK) return
    const fresh = ready.slice(current.spoken.length).trim()
    current.spoken = ready
    if (fresh) {
      clearWaiting()
      enqueue(fresh, 'answer')
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
    if (spoken === ANSWER_FALLBACK) {
      // The answer exists but cannot be read — code, a table, markup. The bank
      // line says it is ready, and the group rotates so a run of such answers
      // does not repeat one sentence. `ANSWER_FALLBACK` itself stays the
      // sentinel the streaming path compares against.
      const index = cueIndex.current.answerReady ?? 0
      cueIndex.current.answerReady = index + 1
      const line = speechLine('answerReady', index)
      if (line) enqueue(line.text)
      return
    }
    // Final text normally extends the streamed prefix. Never repeat that prefix.
    if (spoken.startsWith(current.spoken)) {
      const rest = spoken.slice(current.spoken.length).trim()
      if (rest) enqueue(rest, 'answer')
      else if (!spoken && !failed && text.trim()) {
        // The answer exists and was deliberately not read. Two cases share this
        // branch and they are not the same sentence: a text task is reviewed on
        // the card ("Текст готов."), while an answer with nothing readable in it
        // — code, a table — is just ready ("Ответ готов.").
        const cue = speechText(text) ? 'textReady' : 'answerReady'
        const index = cueIndex.current[cue] ?? 0
        cueIndex.current[cue] = index + 1
        const line = speechLine(cue, index)
        if (line) enqueue(line.text)
      }
    } else if (failed) {
      stop()
      enqueue(spoken, 'answer')
    } else if (spoken) {
      enqueue(spoken, 'answer')
    }
  }, [enqueue, stop, clearWaiting])

  useEffect(() => {
    const offRecord = window.deskhand.voice.onRecord(stop)
    const offPreparing = window.deskhand.overlay.onPreparing(stop)
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
  return { speaking, error, speak, say, stop, begin, append, finish }
}
