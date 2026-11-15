import { useCallback, useEffect, useRef, useState } from 'react'
import type { TtsSettings, TtsSetupProgress, TtsStatus, VoiceSettings } from '@shared/types'
import {
  PREVIEW_LINE,
  SILERO_SPEAKERS,
  SPEECH_RATE,
  SPEECH_VOICE_RETRIES,
  SPEECH_VOICE_RETRY_MS,
  sileroSpeaker
} from '@shared/tts'
import { Disclosure, Group, Row, ToggleRow } from './Row'

/** The local macOS voice for the preview line, waited for while Chromium fills its list. */
async function systemPreviewVoice(stillWanted: () => boolean): Promise<SpeechSynthesisVoice | null> {
  for (let attempt = 0; attempt < SPEECH_VOICE_RETRIES; attempt++) {
    const voice = window.speechSynthesis?.getVoices()
      .find((candidate) => candidate.localService && candidate.lang.toLowerCase().startsWith('ru'))
    if (voice) return voice
    if (!stillWanted()) return null
    await new Promise((resolve) => setTimeout(resolve, SPEECH_VOICE_RETRY_MS))
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
    utterance.rate = SPEECH_RATE
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
  const [statusFailed, setStatusFailed] = useState(false)
  const [keyError, setKeyError] = useState<string | null>(null)
  const [keyBusy, setKeyBusy] = useState(false)
  const keyPending = useRef(false)
  const [setupBusy, setSetupBusy] = useState(false)
  const setupPending = useRef(false)
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
    setStatusFailed(false)
    void window.deskhand.tts.status()
      .then((next) => { if (request === ttsStatusRequest.current) setSpeech(next) })
      .catch(() => {
        if (request !== ttsStatusRequest.current) return
        setSpeech(null)
        setStatusFailed(true)
      })
  }, [])

  useEffect(() => {
    refreshTts()
  }, [refreshTts, savedTtsConfig])
  useEffect(() => window.deskhand.tts.onSetupProgress((progress) => {
    setSetupProgress(progress.done ? null : progress)
    if (progress.error) setSetupError(progress.error)
  }), [])
  async function changeTtsKey(action: 'save' | 'remove'): Promise<void> {
    const key = ttsKey.trim()
    if (keyPending.current || (action === 'save' && !key)) return
    keyPending.current = true
    setKeyBusy(true)
    setKeyError(null)
    try {
      if (action === 'save') {
        await window.deskhand.tts.setKey(key)
        setTtsKeyInput('')
      } else {
        await window.deskhand.tts.deleteKey()
      }
      refreshTts()
    } catch {
      setKeyError(action === 'save' ? 'Не удалось сохранить ключ. Попробуй ещё раз.' : 'Не удалось удалить ключ. Попробуй ещё раз.')
    } finally {
      keyPending.current = false
      setKeyBusy(false)
    }
  }

  async function changeSilero(action: 'install' | 'remove'): Promise<void> {
    if (setupPending.current) return
    if (action === 'remove' && !window.confirm('Удалить Silero и скачанные файлы с этого Mac?')) return
    setupPending.current = true
    setSetupBusy(true)
    setSetupError(null)
    if (action === 'install') setSetupProgress({ stage: 'python', received: 0, total: 0, done: false })
    try {
      if (action === 'install') {
        const result = await window.deskhand.tts.installSilero()
        if (result.error) setSetupError(result.error)
      } else {
        await window.deskhand.tts.removeSilero()
      }
    } catch {
      setSetupError(action === 'install' ? 'Не удалось установить Silero. Попробуй ещё раз.' : 'Не удалось удалить Silero. Попробуй ещё раз.')
    } finally {
      setupPending.current = false
      setSetupBusy(false)
      setSetupProgress(null)
      refreshTts()
    }
  }

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
      // Invalidate every preview in flight. This has to read the counter as it
      // is at unmount, not as it was when the effect ran: a preview started
      // later owns a higher generation, and a copied value would leave it
      // current instead of stale.
      // eslint-disable-next-line react-hooks/exhaustive-deps
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
    if (statusFailed) previewHint = 'Не удалось проверить настройки нейроголоса.'
    else if (!matchingStatus) previewHint = 'Проверяю настройки нейроголоса…'
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
            {neural && statusFailed
              ? <button onClick={refreshTts}>Повторить проверку</button>
              : <button disabled={previewing || !previewReady || (neural && (setupBusy || keyBusy))}
                  onClick={() => void previewVoice()}>
                  {previewing ? 'Играет…' : 'Послушать пример'}
                </button>}
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
                  ? 'Скачанные веса работают офлайн.'
                  : sileroInstalled === false ? 'Скачай один раз. Нужно около 300 МБ и Python 3.12+.'
                    : statusFailed ? 'Статус установки недоступен.' : 'Проверяю установку…'}
          >
            {sileroInstalled === true && (
              <button className="ghost" disabled={setupBusy} onClick={() => void changeSilero('remove')}>Удалить модель</button>
            )}
            {sileroInstalled === false && (
              <button disabled={setupBusy} onClick={() => void changeSilero('install')}>
                {setupBusy ? 'Установка…' : 'Скачать модель'}
              </button>
            )}
          </Row>
          <ToggleRow
            title="Уточнять произношение"
            hint="Незнакомые английские слова уточняются у текстовой модели один раз и кэшируются. Выключи, если Silero должен работать полностью офлайн."
            checked={tts.pronunciationLookup}
            onChange={(pronunciationLookup) => onTtsChange({ pronunciationLookup })}
          />
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
            hint={keyError
              ? <span className="row-hint err" role="alert">{keyError}</span>
              : speech?.keyConfigured ? 'Сохранён в Keychain.' : undefined}>
            {speech?.keyConfigured ? (
              <button className="ghost" disabled={keyBusy} onClick={() => void changeTtsKey('remove')}>Удалить ключ</button>
            ) : (
              <div className="row-actions">
                <input id="voice-api-key" type="password" disabled={keyBusy} value={ttsKey} placeholder="Ключ сервиса"
                  onChange={(event) => setTtsKeyInput(event.target.value)}
                  onKeyDown={(event) => { if (event.key === 'Enter') void changeTtsKey('save') }} />
                <button disabled={keyBusy || !ttsKey.trim()} onClick={() => void changeTtsKey('save')}>Сохранить</button>
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
