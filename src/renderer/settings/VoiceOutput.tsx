import { useCallback, useEffect, useRef, useState } from 'react'
import type { TtsSettings, TtsSetupProgress, TtsStatus, VoiceSettings } from '@shared/types'
import { PREVIEW_LINE, SILERO_SPEAKERS, sileroSpeaker } from '@shared/tts'
import { Disclosure, Group, Row, ToggleRow } from './Row'

/** Chromium lists the macOS voices a frame or two after the first ask. */
const SYSTEM_VOICE_RETRY_MS = 200
const SYSTEM_VOICE_RETRIES = 10
/** The same pace the card reads answers at. */
const SYSTEM_PREVIEW_RATE = 1.3

/** The local macOS voice for the preview line, waited for while Chromium fills its list. */
async function systemPreviewVoice(stillWanted: () => boolean): Promise<SpeechSynthesisVoice | null> {
  for (let attempt = 0; attempt < SYSTEM_VOICE_RETRIES; attempt++) {
    const voice = window.speechSynthesis?.getVoices()
      .find((candidate) => candidate.localService && candidate.lang.toLowerCase().startsWith('ru'))
    if (voice) return voice
    if (!stillWanted()) return null
    await new Promise((resolve) => setTimeout(resolve, SYSTEM_VOICE_RETRY_MS))
  }
  return null
}

/**
 * Speaks the preview line with the macOS voice.
 *
 * The settings window previews the same sentence the neural engine would say, so
 * picking «Голос macOS» is heard as macOS and not as the configured synthesizer.
 */
async function playSystemPreview(stillWanted: () => boolean): Promise<void> {
  const synth = window.speechSynthesis
  const voice = synth ? await systemPreviewVoice(stillWanted) : null
  if (!synth || !voice) {
    throw new Error('Нет доступного системного голоса для этого языка. Добавь голос в настройках macOS.')
  }
  if (!stillWanted()) return
  await new Promise<void>((resolve, reject) => {
    const utterance = new SpeechSynthesisUtterance(PREVIEW_LINE)
    utterance.voice = voice
    utterance.lang = voice.lang
    utterance.rate = SYSTEM_PREVIEW_RATE
    utterance.onend = () => resolve()
    utterance.onerror = () => reject(new Error('Не удалось воспроизвести пример.'))
    synth.speak(utterance)
  })
}

interface VoiceOutputProps {
  active: boolean
  savedTts: TtsSettings
  voice: VoiceSettings
  tts: TtsSettings
  onVoiceChange(changes: Partial<VoiceSettings>): void
  onTtsChange(changes: Partial<TtsSettings>): void
}

/** One line for the Silero download row: what is happening and how far along it is. */
function setupProgressText(progress: TtsSetupProgress): string {
  if (progress.stage === 'python') return 'Ищу Python 3.12+…'
  if (progress.stage === 'runtime') return 'Ставлю движок Silero…'
  if (progress.done || progress.total === 0) return 'Скачиваю модель…'
  return `Скачиваю модель: ${Math.round((progress.received / progress.total) * 100)}%`
}

/** How the assistant sounds: which voice reads the answer, and the engine behind it. */
export function VoiceOutput({
  active, voice, tts, savedTts, onVoiceChange, onTtsChange
}: VoiceOutputProps) {
  const [speech, setSpeech] = useState<TtsStatus | null>(null)
  const [ttsKey, setTtsKeyInput] = useState('')
  const [previewing, setPreviewing] = useState(false)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [setupProgress, setSetupProgress] = useState<TtsSetupProgress | null>(null)
  const [setupError, setSetupError] = useState<string | null>(null)
  const previewAudio = useRef<HTMLAudioElement | null>(null)
  const previewGeneration = useRef(0)
  const ttsConfig = JSON.stringify(tts)
  const savedTtsConfig = JSON.stringify(savedTts)
  const ttsApplying = ttsConfig !== savedTtsConfig
  const ttsStatusRequest = useRef(0)
  const refreshTts = useCallback(() => {
    const request = ++ttsStatusRequest.current
    void window.deskhand.tts.status()
      .then((next) => { if (request === ttsStatusRequest.current) setSpeech(next) })
      .catch(() => { if (request === ttsStatusRequest.current) setSpeech(null) })
  }, [])

  useEffect(() => {
    refreshTts()
  }, [refreshTts, savedTtsConfig])
  useEffect(() => window.deskhand.tts.onSetupProgress((progress) => {
    setSetupProgress(progress.done ? null : progress)
    if (progress.error) setSetupError(progress.error)
  }), [])
  /** Stores the synthesis key; the value never comes back from the main process. */
  const saveTtsKey = useCallback(async () => {
    if (!ttsKey.trim()) return
    setSpeech(await window.deskhand.tts.setKey(ttsKey.trim()))
    setTtsKeyInput('')
  }, [ttsKey])

  const removeTtsKey = useCallback(async () => {
    setSpeech(await window.deskhand.tts.deleteKey())
  }, [])

  /** Downloads or repairs the local Silero runtime; the pane shows each stage. */
  const installSileroEngine = useCallback(async () => {
    setSetupError(null)
    setSetupProgress({ stage: 'python', received: 0, total: 0, done: false })
    try {
      const result = await window.deskhand.tts.installSilero()
      setSpeech(result.status)
      if (result.error) setSetupError(result.error)
    } catch (error) {
      setSetupError(error instanceof Error ? error.message : 'Не удалось установить Silero. Попробуй ещё раз.')
    } finally {
      setSetupProgress(null)
      refreshTts()
    }
  }, [refreshTts])

  const removeSileroEngine = useCallback(async () => {
    if (!window.confirm('Удалить Silero и скачанные файлы с этого Mac?')) return
    setSetupError(null)
    try {
      setSpeech(await window.deskhand.tts.removeSilero())
    } catch {
      setSetupError('Не удалось удалить Silero. Попробуй ещё раз.')
    }
  }, [])

  /** Plays one fixed line in the selected voice, so the choice can be judged. */
  const previewVoice = useCallback(async () => {
    const generation = ++previewGeneration.current
    setPreviewing(true)
    setPreviewError(null)

    if (voice.answerVoice === 'system') {
      try {
        await playSystemPreview(() => previewGeneration.current === generation)
      } catch (error) {
        if (previewGeneration.current === generation) {
          setPreviewError(error instanceof Error ? error.message : 'Не удалось воспроизвести пример.')
        }
      } finally {
        if (previewGeneration.current === generation) setPreviewing(false)
      }
      return
    }

    try {
      const result = await window.deskhand.tts.preview()
      if (previewGeneration.current !== generation) return
      if (!result.ok) {
        setPreviewing(false)
        setPreviewError(result.message)
        return
      }
      previewAudio.current?.pause()
      const element = new Audio(`data:${result.mime || 'audio/mpeg'};base64,${result.audio}`)
      previewAudio.current = element
      element.onended = () => setPreviewing(false)
      element.onerror = () => {
        setPreviewing(false)
        setPreviewError('Не удалось воспроизвести пример.')
      }
      await element.play()
    } catch (error) {
      if (previewGeneration.current !== generation) return
      setPreviewing(false)
      setPreviewError(error instanceof Error ? error.message : 'Не удалось получить пример.')
    } finally {
      if (previewGeneration.current === generation) refreshTts()
    }
  }, [refreshTts, voice.answerVoice])

  useEffect(() => {
    setPreviewing(false)
    setPreviewError(null)
    return () => {
      previewGeneration.current++
      window.speechSynthesis?.cancel()
      const element = previewAudio.current
      if (!element) return
      element.onended = null
      element.onerror = null
      element.pause()
      previewAudio.current = null
    }
  }, [ttsConfig, voice.answerVoice, active])

  const mode = voice.answerVoice === 'neural' ? tts.engine : voice.answerVoice
  const neural = voice.answerVoice === 'neural'
  const matchingStatus = !ttsApplying && speech?.engine === tts.engine ? speech : null
  const sileroInstalled = speech?.engine === 'silero' ? speech.silero?.installed : undefined
  const previewReady = mode === 'system' || (neural && matchingStatus?.configured === true)
  let previewHint = 'Короткий пример голосом macOS.'
  if (neural) {
    if (!matchingStatus) previewHint = 'Проверяю настройки нейроголоса…'
    else if (!matchingStatus.configured) {
      previewHint = mode === 'silero'
        ? 'До настройки Silero ответы читает голос macOS.'
        : 'До подключения сервиса ответы читает голос macOS.'
    }
    else previewHint = matchingStatus.reason ?? 'Пример выбранного нейроголоса.'
  }

  return (
    <>
      <Group title="Ответы вслух">
        <Row title="Голос ответов">
          <select
            aria-label="Голос ответов"
            value={mode}
            onChange={(event) => {
              const next = event.target.value
              if (next === 'off' || next === 'system') onVoiceChange({ answerVoice: next })
              if (next === 'silero' || next === 'remote') {
                onTtsChange({ engine: next, enabled: true })
                onVoiceChange({ answerVoice: 'neural' })
              }
            }}
          >
            <option value="off">Не читать автоматически</option>
            <option value="system">Голос macOS</option>
            <option value="silero">Silero на этом Mac</option>
            <option value="remote">Свой сервис по API</option>
          </select>
        </Row>
        {mode !== 'off' && (
          <Row title="Пример голоса" hint={<span role="status">{previewError ?? previewHint}</span>}>
            <button disabled={previewing || !previewReady} onClick={() => void previewVoice()}>
              {previewing ? 'Играет…' : 'Послушать пример'}
            </button>
          </Row>
        )}
      </Group>

      {mode === 'silero' && (
        <Group title="Silero" footnote="Silero V5.6 RU · CC BY-NC-SA 4.0 · для некоммерческого теста.">
          {sileroInstalled && (
            <Row title="Голос Silero">
              <select
                aria-label="Голос Silero"
                value={sileroSpeaker(tts.sileroVoice)}
                onChange={(event) => onTtsChange({ sileroVoice: event.target.value })}
              >
                {SILERO_SPEAKERS.map((speaker) => (
                  <option key={speaker} value={speaker}>{speaker}</option>
                ))}
              </select>
            </Row>
          )}
          <Row
            title={sileroInstalled === false ? 'Модель не установлена' : 'Модель Silero'}
            hint={setupError
              ? <span className="row-hint err" role="alert">{setupError}</span>
              : setupProgress
                ? <span role="status">{setupProgressText(setupProgress)}</span>
                : sileroInstalled
                  ? 'Работает без интернета.'
                  : sileroInstalled === false ? 'Скачай один раз. Нужно около 300 МБ и Python 3.12+.' : 'Проверяю установку…'}
          >
            {sileroInstalled === true && (
              <button className="ghost" disabled={setupProgress !== null} onClick={() => void removeSileroEngine()}>Удалить модель</button>
            )}
            {sileroInstalled === false && (
              <button disabled={setupProgress !== null} onClick={() => void installSileroEngine()}>
                {setupProgress ? 'Установка…' : 'Скачать модель'}
              </button>
            )}
          </Row>
          {sileroInstalled && !tts.enabled && (
            <Row title="Нейроголос выключен">
              <button onClick={() => onTtsChange({ enabled: true })}>Включить Silero</button>
            </Row>
          )}
        </Group>
      )}

      {mode === 'remote' && (
        <Group title="Сервис озвучки по API" footnote="Подключи OpenAI-совместимый сервис синтеза речи.">
          <Row title={<label htmlFor="voice-api-url">Адрес API</label>}>
            <input id="voice-api-url" value={tts.baseUrl} placeholder="https://host/v1" spellCheck={false}
              onChange={(event) => onTtsChange({ baseUrl: event.target.value })} />
          </Row>
          <Row title={<label htmlFor="voice-api-model">Модель</label>}>
            <input id="voice-api-model" value={tts.model} placeholder="ID модели" spellCheck={false}
              onChange={(event) => onTtsChange({ model: event.target.value })} />
          </Row>
          <Row title={<label htmlFor="voice-api-speaker">Голос</label>}>
            <input id="voice-api-speaker" value={tts.voice} placeholder="Имя голоса" spellCheck={false}
              onChange={(event) => onTtsChange({ voice: event.target.value })} />
          </Row>
          <Row title={speech?.keyConfigured ? 'Ключ API' : <label htmlFor="voice-api-key">Ключ API</label>}
            hint={speech?.keyConfigured ? 'Сохранён в Keychain.' : undefined}>
            {speech?.keyConfigured ? (
              <button className="ghost" onClick={() => void removeTtsKey()}>Удалить ключ</button>
            ) : (
              <div className="row-actions">
                <input id="voice-api-key" type="password" value={ttsKey} placeholder="Ключ сервиса"
                  onChange={(event) => setTtsKeyInput(event.target.value)}
                  onKeyDown={(event) => { if (event.key === 'Enter') void saveTtsKey() }} />
                <button disabled={!ttsKey.trim()} onClick={() => void saveTtsKey()}>Сохранить</button>
              </div>
            )}
          </Row>
          <Disclosure title="Стиль речи">
            <Row title={<label htmlFor="voice-api-style">Инструкция для голоса</label>}>
              <input id="voice-api-style" value={tts.style} placeholder="Например, спокойно"
                onChange={(event) => onTtsChange({ style: event.target.value })} />
            </Row>
          </Disclosure>
          {!tts.enabled && (
            <Row title="Нейроголос выключен">
              <button onClick={() => onTtsChange({ enabled: true })}>Включить озвучку через API</button>
            </Row>
          )}
        </Group>
      )}

      <Group title="Ход работы">
        <ToggleRow
          title="Озвучивать ход работы"
          hint="Короткие реплики, пока агент выполняет задачу."
          checked={voice.agentFeedback}
          onChange={(agentFeedback) => onVoiceChange({ agentFeedback })}
        />
      </Group>
    </>
  )
}
