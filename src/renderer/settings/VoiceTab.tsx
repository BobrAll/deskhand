import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import type {
  DownloadProgress,
  TtsSetupProgress,
  TtsSettings,
  TtsStatus,
  VoiceSettings,
  VoiceStatus
} from '@shared/types'
import {
  WHISPER_LANGUAGES,
  BUNDLED_VOICE_MODEL,
  WHISPER_MODELS,
  voiceModel
} from '@shared/defaults'
import { PREVIEW_LINE, SILERO_SPEAKERS, sileroSpeaker } from '@shared/tts'
import { Disclosure, Group, Row, ToggleRow } from './Row'
import { InstallList } from './InstallList'
import { HotkeyField } from './HotkeyField'
import { startRecording } from '../overlay/recorder'

const MICROPHONE_LEVEL_BARS = 12

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

interface VoiceTabProps {
  microphoneGranted: boolean
  onOpenMicrophoneSettings(): void
  voice: VoiceSettings
  tts: TtsSettings
  savedVoice: VoiceSettings
  savedTts: TtsSettings
  onVoiceChange(changes: Partial<VoiceSettings>): void
  onTtsChange(changes: Partial<TtsSettings>): void
}

interface ModelListProps {
  /**
   * The model that will actually transcribe, from the main process.
   *
   * `null` when nothing on disk matches — the settings can point at a model that
   * was never downloaded, and that must not read as "selected".
   */
  activeModel: string | null
  installed: ReadonlySet<string>
  progress: DownloadProgress | null
  deleting: string | null
  downloadError: string | null
  onPick(id: string): void
  onDownload(id: string): void
  onImport(): void
  onRemove(id: string, label: string): void
}

/** Which recognition models are on disk, and the ways to get more of them. */
function ModelList({ activeModel, installed, progress, deleting, downloadError, ...handlers }: ModelListProps) {
  return (
    <InstallList
      entries={WHISPER_MODELS.map((entry) => ({
        id: entry.id,
        label: entry.label,
        meta: `${entry.mb} МБ · ${entry.note}`
      }))}
      active={activeModel}
      installed={installed}
      progress={progress}
      deleting={deleting}
      error={downloadError}
      extras={Array.from(installed).filter((id) => !voiceModel(id))}
      {...handlers}
    />
  )
}

interface TtsSectionProps {
  voice: VoiceSettings
  tts: TtsSettings
  speech: TtsStatus | null
  applying: boolean
  ttsKey: string
  previewing: boolean
  previewError: string | null
  setupProgress: TtsSetupProgress | null
  setupError: string | null
  onVoiceChange(changes: Partial<VoiceSettings>): void
  onTtsChange(changes: Partial<TtsSettings>): void
  onTtsKeyInput(value: string): void
  onSaveKey(): void
  onRemoveKey(): void
  onPreview(): void
  onInstallSilero(): void
  onRemoveSilero(): void
}

/** One line for the Silero download row: what is happening and how far along it is. */
function setupProgressText(progress: TtsSetupProgress): string {
  if (progress.stage === 'python') return 'Ищу Python 3.12+…'
  if (progress.stage === 'runtime') return 'Ставлю движок Silero…'
  if (progress.done || progress.total === 0) return 'Скачиваю модель…'
  return `Скачиваю модель: ${Math.round((progress.received / progress.total) * 100)}%`
}

/** How the assistant sounds: which voice reads the answer, and the engine behind it. */
function TtsSection({
  voice,
  tts,
  speech,
  applying,
  ttsKey,
  previewing,
  previewError,
  setupProgress,
  setupError,
  onVoiceChange,
  onTtsChange,
  onTtsKeyInput,
  onSaveKey,
  onRemoveKey,
  onPreview,
  onInstallSilero,
  onRemoveSilero
}: TtsSectionProps) {
  const mode = voice.answerVoice === 'neural' ? tts.engine : voice.answerVoice
  const neural = voice.answerVoice === 'neural'
  const matchingStatus = !applying && speech?.engine === tts.engine ? speech : null
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
            <button disabled={previewing || !previewReady} onClick={onPreview}>
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
              <button className="ghost" disabled={setupProgress !== null} onClick={onRemoveSilero}>Удалить модель</button>
            )}
            {sileroInstalled === false && (
              <button disabled={setupProgress !== null} onClick={onInstallSilero}>
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
              <button className="ghost" onClick={onRemoveKey}>Удалить ключ</button>
            ) : (
              <div className="row-actions">
                <input id="voice-api-key" type="password" value={ttsKey} placeholder="Ключ сервиса"
                  onChange={(event) => onTtsKeyInput(event.target.value)}
                  onKeyDown={(event) => { if (event.key === 'Enter') onSaveKey() }} />
                <button disabled={!ttsKey.trim()} onClick={onSaveKey}>Сохранить</button>
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

type MicrophoneTest =
  | { phase: 'idle' | 'starting' }
  | { phase: 'listening'; level: number }
  | { phase: 'finished'; heard: boolean }
  | { phase: 'error'; message: string }

function MicrophoneCheck({
  test, onCheck, onCancel, onOpenMicrophoneSettings
}: {
  test: MicrophoneTest
  onCheck(): void
  onCancel(): void
  onOpenMicrophoneSettings(): void
}) {
  const active = test.phase === 'starting' || test.phase === 'listening'
  let message = 'Скажи пару слов, чтобы проверить сигнал.'
  if (test.phase === 'starting') message = 'Подключаю микрофон…'
  if (test.phase === 'listening') message = 'Говори и смотри на полоски. Нажми «Остановить», когда закончишь.'
  if (test.phase === 'finished') {
    message = test.heard ? 'Микрофон работает. Сигнал есть.' : 'Сигнал слишком тихий. Подойди ближе и попробуй ещё раз.'
  }
  if (test.phase === 'error') message = test.message

  return (
    <Group title="Микрофон">
      <Row title="Проверка микрофона" hint={<span role="status">{message}</span>}>
        <button type="button" onClick={active ? onCancel : onCheck}>
          {active ? 'Остановить' : 'Проверить микрофон'}
        </button>
      </Row>
      {test.phase === 'listening' && (
        <Row stacked>
          <div className="microphone-level" role="meter" aria-label="Уровень сигнала"
            aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(test.level * 100)}>
            {Array.from({ length: MICROPHONE_LEVEL_BARS }, (_, index) => (
              <span key={index} data-lit={index < Math.ceil(test.level * MICROPHONE_LEVEL_BARS)} />
            ))}
          </div>
        </Row>
      )}
      {test.phase === 'error' && (
        <Row><button type="button" onClick={onOpenMicrophoneSettings}>Открыть «Приватность»</button></Row>
      )}
    </Group>
  )
}

export function VoiceTab({
  voice,
  tts,
  savedVoice,
  savedTts,
  microphoneGranted,
  onOpenMicrophoneSettings,
  onVoiceChange,
  onTtsChange
}: VoiceTabProps) {
  const { model: savedModel, enabled: savedVoiceEnabled, hotkey: savedHotkey } = savedVoice
  const [section, setSection] = useState<'input' | 'speech'>('input')
  const sectionId = useId()
  const [status, setStatus] = useState<VoiceStatus | null>(null)
  const [speech, setSpeech] = useState<TtsStatus | null>(null)
  const [ttsKey, setTtsKeyInput] = useState('')
  const [previewing, setPreviewing] = useState(false)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [setupProgress, setSetupProgress] = useState<TtsSetupProgress | null>(null)
  const [setupError, setSetupError] = useState<string | null>(null)
  const previewAudio = useRef<HTMLAudioElement | null>(null)
  const previewGeneration = useRef(0)
  const [deleting, setDeleting] = useState<string | null>(null)
  const [progress, setProgress] = useState<DownloadProgress | null>(null)
  const [downloadError, setDownloadError] = useState<string | null>(null)
  const [microphoneTest, setMicrophoneTest] = useState<MicrophoneTest>({ phase: 'idle' })
  const microphoneCheck = useRef<AbortController | null>(null)
  const ttsConfig = JSON.stringify(tts)
  const savedTtsConfig = JSON.stringify(savedTts)
  const ttsApplying = ttsConfig !== savedTtsConfig
  const voiceStatusRequest = useRef(0)
  const ttsStatusRequest = useRef(0)

  const refreshVoice = useCallback(() => {
    const request = ++voiceStatusRequest.current
    void window.deskhand.voice
      .status()
      .then((next) => { if (request === voiceStatusRequest.current) setStatus(next) })
      .catch(() => { if (request === voiceStatusRequest.current) setStatus(null) })
  }, [])

  useEffect(() => {
    refreshVoice()
  }, [refreshVoice, savedModel, savedVoiceEnabled, savedHotkey])

  const refreshTts = useCallback(() => {
    const request = ++ttsStatusRequest.current
    void window.deskhand.tts.status()
      .then((next) => { if (request === ttsStatusRequest.current) setSpeech(next) })
      .catch(() => { if (request === ttsStatusRequest.current) setSpeech(null) })
  }, [])

  useEffect(() => {
    refreshTts()
  }, [refreshTts, savedTtsConfig])

  useEffect(() => window.deskhand.voice.onDownloadProgress((event) => {
    if (event.error) setDownloadError(event.error)
    if (!event.done) setProgress(event)
  }), [])

  useEffect(() => window.deskhand.tts.onSetupProgress((progress) => {
    setSetupProgress(progress.done ? null : progress)
    if (progress.error) setSetupError(progress.error)
  }), [])

  const installed = useMemo(() => new Set(status?.installed ?? []), [status])

  /**
   * Makes the draft agree with the model the main process says is in use.
   *
   * The settings window edits a draft and writes it on a debounce, so a draft
   * that still pointed at the old model would write it back over the change on
   * the next keystroke — the selection would look right until the user touched
   * anything else. Called only after an action the user took, never on a plain
   * status read: a read must not edit their settings.
   */
  const adoptSelection = useCallback(
    (next: VoiceStatus | null) => {
      if (!next) return
      const model = next.activeModel ?? BUNDLED_VOICE_MODEL.id
      if (model !== voice.model) onVoiceChange({ model })
    },
    [onVoiceChange, voice.model]
  )

  const download = useCallback(
    async (id: string) => {
      setDownloadError(null)
      setProgress({ model: id, received: 0, total: 0, done: false })
      try {
        const next = await window.deskhand.voice.download(id)
        setStatus(next)
        if (next.activeModel === id) adoptSelection(next)
      } catch {
        setDownloadError('Не удалось скачать модель. Проверь соединение и попробуй снова.')
      } finally {
        setProgress(null)
      }
    },
    [adoptSelection]
  )

  async function importModel(): Promise<void> {
    setDownloadError(null)
    try {
      const next = await window.deskhand.voice.importModel()
      if (next) {
        setStatus(next)
        adoptSelection(next)
      }
    } catch {
      setDownloadError('Не удалось импортировать модель. Попробуй снова.')
    }
  }

  async function remove(id: string, label: string): Promise<void> {
    if (!window.confirm(`Удалить модель «${label}» с этого Mac?`)) return
    setDownloadError(null)
    setDeleting(id)
    try {
      const next = await window.deskhand.voice.deleteModel(id)
      setStatus(next)
      // Main restores the bundled model if the selected model was deleted.
      adoptSelection(next)
    } catch {
      setDownloadError('Не удалось удалить модель. Попробуй снова.')
    } finally {
      setDeleting(null)
    }
  }

  const cancelMicrophoneCheck = useCallback(() => {
    microphoneCheck.current?.abort()
    setMicrophoneTest({ phase: 'idle' })
  }, [])

  useEffect(() => () => microphoneCheck.current?.abort(), [])

  async function checkMicrophone(): Promise<void> {
    if (microphoneCheck.current) return
    const controller = new AbortController()
    microphoneCheck.current = controller
    const { signal } = controller
    setMicrophoneTest({ phase: 'starting' })
    try {
      const recording = await startRecording(0)
      let peak = 0
      const sampleLevel = () => {
        const level = recording.level()
        peak = Math.max(peak, level)
        setMicrophoneTest({ phase: 'listening', level })
      }
      try {
        if (signal.aborted) return
        sampleLevel()
        await new Promise<void>((resolve) => {
          const meter = window.setInterval(sampleLevel, 80)
          const finish = () => {
            window.clearInterval(meter)
            signal.removeEventListener('abort', finish)
            resolve()
          }
          signal.addEventListener('abort', finish, { once: true })
        })
      } finally {
        await recording.stop(false)
      }
      if (signal.reason === 'finished') setMicrophoneTest({ phase: 'finished', heard: peak >= 0.025 })
    } catch (error) {
      if (!signal.aborted) {
        const name = error instanceof Error ? error.name : ''
        const message = name === 'NotAllowedError'
          ? 'Разреши Deskhand доступ к микрофону в настройках macOS.'
          : name === 'NotFoundError'
            ? 'Микрофон не найден. Подключи его и попробуй ещё раз.'
            : 'Не удалось открыть микрофон. Проверь устройство ввода и попробуй ещё раз.'
        setMicrophoneTest({ phase: 'error', message })
      }
    } finally {
      if (microphoneCheck.current === controller) microphoneCheck.current = null
    }
  }

  // Reflect a click on an installed model while its settings are being saved.
  const selectedModel = installed.has(voice.model) ? voice.model : status?.activeModel ?? null
  const selected = voiceModel(selectedModel ?? '')
  const modelName = selected?.label ?? selectedModel

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
  }, [ttsConfig, voice.answerVoice, section])

  return (
    <div className="pane voice-pane">
      <nav className="segmented" aria-label="Раздел звука и голоса">
        {(['input', 'speech'] as const).map((item) => (
          <button
            key={item}
            type="button"
            className={section === item ? 'active' : undefined}
            aria-pressed={section === item}
            aria-controls={`${sectionId}-${item}`}
            onClick={() => {
              if (item !== section) cancelMicrophoneCheck()
              setSection(item)
            }}
          >
            {item === 'input' ? 'Ввод' : 'Озвучка'}
          </button>
        ))}
      </nav>
      <div className="voice-section" id={`${sectionId}-input`} hidden={section !== 'input'}>
        <MicrophoneCheck
          test={microphoneTest}
          onCheck={() => void checkMicrophone()}
          onCancel={() => {
            if (microphoneTest.phase === 'listening') microphoneCheck.current?.abort('finished')
            else cancelMicrophoneCheck()
          }}
          onOpenMicrophoneSettings={onOpenMicrophoneSettings}
        />
        <Group title="Запись и команды">
          <ToggleRow
            title="Голосовой ввод"
            checked={voice.enabled}
            onChange={(enabled) => onVoiceChange({ enabled })}
          />
          <Row title="Клавиша записи" hint="Удерживай её, пока говоришь.">
            <HotkeyField value={voice.hotkey} onChange={(hotkey) => onVoiceChange({ hotkey })} />
          </Row>
          <Row title="После записи">
            <select
              aria-label="После записи"
              value={voice.action === 'dictate' ? 'dictate' : voice.autoSend ? 'send' : 'review'}
              onChange={(event) => {
                const action = event.target.value
                onVoiceChange(action === 'dictate'
                  ? { action: 'dictate' }
                  : { action: 'command', autoSend: action === 'send' })
              }}
            >
              <option value="review">Подготовить запрос</option>
              <option value="send">Отправить запрос сразу</option>
              <option value="dictate">Вставить текст</option>
            </select>
          </Row>
          {voice.enabled && !microphoneGranted && (
            <Row title="Доступ к микрофону" hint="Разреши доступ, чтобы записывать голосовые команды.">
              <button onClick={onOpenMicrophoneSettings}>Открыть «Приватность»</button>
            </Row>
          )}
          {voice.enabled && status?.listenerError && (
            <Row hint={<span className="row-hint err">{status.listenerError}</span>} />
          )}
        </Group>
        <Group title="Распознавание речи">
          <Row
            title={modelName ?? (status ? 'Модель недоступна' : 'Модель распознавания')}
            hint={voice.model !== savedModel
              ? 'Применяю модель…'
              : status?.detail
                ?? (selectedModel === BUNDLED_VOICE_MODEL.id
                  ? 'Встроенная модель для русского языка.'
                  : selectedModel ? 'Речь распознаётся на этом Mac.' : 'Проверяю модель…')}
          />
          {selectedModel && selectedModel !== BUNDLED_VOICE_MODEL.id && (
            <Row title="Язык речи">
              <select
                value={voice.language}
                aria-label="Язык речи"
                onChange={(event) => onVoiceChange({ language: event.target.value })}
              >
                {WHISPER_LANGUAGES.map((language) => (
                  <option key={language.id} value={language.id}>{language.label}</option>
                ))}
              </select>
            </Row>
          )}
          <Disclosure title="Управление моделями">
            {voice.model !== BUNDLED_VOICE_MODEL.id && installed.has(BUNDLED_VOICE_MODEL.id) && (
              <Row title={BUNDLED_VOICE_MODEL.label} hint="Встроенная модель для русского языка.">
                <button disabled={progress !== null || deleting !== null} onClick={() => onVoiceChange({ model: BUNDLED_VOICE_MODEL.id })}>
                  Использовать GigaAM
                </button>
              </Row>
            )}
            <ModelList
              activeModel={selectedModel}
              installed={installed}
              progress={progress}
              deleting={deleting}
              downloadError={downloadError}
              onPick={(id) => onVoiceChange({ model: id })}
              onDownload={(id) => void download(id)}
              onImport={() => void importModel()}
              onRemove={(id, label) => void remove(id, label)}
            />
          </Disclosure>
        </Group>
      </div>
      <div className="voice-section" id={`${sectionId}-speech`} hidden={section !== 'speech'}>
        <TtsSection
          voice={voice}
          tts={tts}
          speech={speech}
          applying={ttsApplying}
          ttsKey={ttsKey}
          previewing={previewing}
          previewError={previewError}
          onVoiceChange={onVoiceChange}
          onTtsChange={onTtsChange}
          onTtsKeyInput={setTtsKeyInput}
          onSaveKey={() => void saveTtsKey()}
          onRemoveKey={() => void removeTtsKey()}
          onPreview={() => void previewVoice()}
          setupProgress={setupProgress}
          setupError={setupError}
          onInstallSilero={() => void installSileroEngine()}
          onRemoveSilero={() => void removeSileroEngine()}
        />
      </div>
    </div>
  )
}
