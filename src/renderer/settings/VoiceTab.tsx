/**
 * The "Голос" settings tab.
 *
 * Everything here is about one promise: hold a key, speak, get an answer without
 * the audio leaving the machine. That makes the section mostly a readiness panel —
 * which whisper model is on disk, how big it is, whether the keyboard tap could
 * start — because those are the only things that can actually be wrong.
 *
 * The pane is the tab's own state and handlers; the cards that only read it are
 * three components below: `ModelList` (which models are on disk), `TtsSection`
 * (how the assistant sounds) and `ReadinessSection` (whether it can run at all).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { DownloadProgress, TtsSettings, TtsStatus, VoiceSettings, VoiceStatus } from '@shared/types'
import { WHISPER_LANGUAGES, VOICE_MODELS, voiceModel } from '@shared/defaults'
import { Group, Row, ToggleRow } from './Row'

interface VoiceTabProps {
  voice: VoiceSettings
  tts: TtsSettings
  savedModel: string
  onVoiceChange(changes: Partial<VoiceSettings>): void
  onTtsChange(changes: Partial<TtsSettings>): void
}

const BYTES_PER_MB = 1024 * 1024

function megabytes(bytes: number): string {
  if (bytes > 0 && bytes < BYTES_PER_MB) return '< 1 МБ'
  return `${Math.round(bytes / BYTES_PER_MB)} МБ`
}

interface ModelListProps {
  /** The model the settings point at. */
  model: string
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
function ModelList({
  model,
  installed,
  progress,
  deleting,
  downloadError,
  onPick,
  onDownload,
  onImport,
  onRemove
}: ModelListProps) {
  const selected = voiceModel(model)

  function renderDeleteButton(id: string, label: string) {
    return (
      <button
        className="model-state"
        disabled={deleting !== null || progress !== null}
        aria-label={`Удалить ${label}`}
        onClick={() => onRemove(id, label)}
      >
        {deleting === id ? 'Удаляем…' : 'Удалить'}
      </button>
    )
  }

  return (
    <Row stacked title="Модель распознавания">
      {downloadError && (
        <div className="row-hint err" role="alert">
          {downloadError}
        </div>
      )}
      <div className="models">
        {VOICE_MODELS.map((entry) => {
          const modelReady = installed.has(entry.id)
          const downloadingThisModel = progress?.model === entry.id && !progress.done
          const share = progress && progress.total > 0 ? progress.received / progress.total : 0
          return (
            <div key={entry.id} className="model-row" data-active={model === entry.id}>
              <button className="model-pick" onClick={() => onPick(entry.id)}>
                <span className="model-name">
                  {entry.label}
                  {entry.recommended && <span className="badge">рекомендовано</span>}
                </span>
                <span className="model-meta">
                  {entry.mb} МБ · {entry.note}
                </span>
              </button>
              {modelReady ? (
                <div className="model-actions">
                  <span className="model-state ok">Готово</span>
                  {renderDeleteButton(entry.id, entry.label)}
                </div>
              ) : downloadingThisModel ? (
                <span className="model-state">
                  {progress.received > 0
                    ? `${megabytes(progress.received)} из ${megabytes(progress.total)}`
                    : 'Подключение…'}
                </span>
              ) : (
                <button
                  className="model-state"
                  disabled={progress !== null || deleting !== null}
                  onClick={() => onDownload(entry.id)}
                >
                  Скачать
                </button>
              )}
              {downloadingThisModel && (
                <div className="model-bar">
                  <i style={{ width: `${Math.round(share * 100)}%` }} />
                </div>
              )}
            </div>
          )
        })}
        {Array.from(installed).filter((id) => !voiceModel(id)).map((file) => (
          <div key={file} className="model-row">
            <span className="model-name">{file}</span>
            {renderDeleteButton(file, file)}
          </div>
        ))}
      </div>
      <div className="row-actions">
        <span className="row-hint">
          {selected ? `Выбрана «${selected.label}».` : 'Модель не выбрана.'}
        </span>
        <button
          className="ghost"
          disabled={progress !== null || deleting !== null}
          onClick={onImport}
        >
          Указать файл ggml-*.bin
        </button>
      </div>
    </Row>
  )
}

interface TtsSectionProps {
  voice: VoiceSettings
  tts: TtsSettings
  speech: TtsStatus | null
  ttsKey: string
  previewing: boolean
  previewError: string | null
  onVoiceChange(changes: Partial<VoiceSettings>): void
  onTtsChange(changes: Partial<TtsSettings>): void
  onTtsKeyInput(value: string): void
  onSaveKey(): void
  onRemoveKey(): void
  onPreview(): void
}

/** How the assistant sounds: which voice reads the answer, and the engine behind it. */
function TtsSection({
  voice,
  tts,
  speech,
  ttsKey,
  previewing,
  previewError,
  onVoiceChange,
  onTtsChange,
  onTtsKeyInput,
  onSaveKey,
  onRemoveKey,
  onPreview
}: TtsSectionProps) {
  return (
    <>
      <Group title="Озвучка">
        <ToggleRow
          title="Короткие реплики агента"
          hint="Что происходит с управлением: старт, долгая работа, вопрос о разрешении, итог. Не чаще раза в 45 секунд."
          checked={voice.agentFeedback}
          onChange={(agentFeedback) => onVoiceChange({ agentFeedback })}
        />
        <Row
          stacked
          title="Голосом ответа"
          hint={
            voice.answerVoice === 'off'
              ? 'Ответ читается на карточке. Кнопка «Прослушать» остаётся.'
              : voice.answerVoice === 'system'
                ? 'Системный голос macOS: бесплатно, офлайн, без ключа.'
                : speech?.configured
                  ? `Нейроголос «${speech.voice || tts.voice}». Один запрос на ответ, дальше из кэша.`
                  : 'Нейроголос не настроен — ответ прочитает системный голос.'
          }
        >
          <div className="segmented">
            <button
              className={voice.answerVoice === 'off' ? 'active' : ''}
              onClick={() => onVoiceChange({ answerVoice: 'off' })}
            >
              Не читать
            </button>
            <button
              className={voice.answerVoice === 'system' ? 'active' : ''}
              onClick={() => onVoiceChange({ answerVoice: 'system' })}
            >
              Системный
            </button>
            <button
              className={voice.answerVoice === 'neural' ? 'active' : ''}
              onClick={() => onVoiceChange({ answerVoice: 'neural' })}
            >
              Нейроголос
            </button>
          </div>
        </Row>
      </Group>

      <Group
        title="Синтез речи"
        footnote={
          speech?.recordedVoice
            ? `Короткие фразы записаны заранее голосом «${speech.recordedVoice}» и звучат мгновенно без ключа и сети. Синтез ниже нужен только для ответов и для фраз, которых нет в записи.`
            : 'Короткие фразы записаны заранее и звучат мгновенно без ключа и сети. Синтез ниже нужен только для ответов и для фраз, которых нет в записи.'
        }
      >
        <ToggleRow
          title="Включить синтез"
          hint="Endpoint, модель, голос и стиль — твои. Ключ хранится в Keychain и не показывается."
          checked={tts.enabled}
          onChange={(enabled) => onTtsChange({ enabled })}
        />
        <Row
          stacked
          title="Адрес сервиса"
          hint="Корень API без завершающего слэша, например https://host/v1."
        >
          <input
            value={tts.baseUrl}
            onChange={(event) => onTtsChange({ baseUrl: event.target.value })}
            placeholder="https://host/v1"
            spellCheck={false}
          />
        </Row>
        <Row stacked title="Модель" hint="ID модели синтеза у этого сервиса.">
          <input
            value={tts.model}
            onChange={(event) => onTtsChange({ model: event.target.value })}
            placeholder="ID модели синтеза"
            spellCheck={false}
          />
        </Row>
        <Row stacked title="Голос" hint="Имя голоса, как его называет сервис.">
          <input
            value={tts.voice}
            onChange={(event) => onTtsChange({ voice: event.target.value })}
            placeholder="имя голоса"
            spellCheck={false}
          />
        </Row>
        <Row
          stacked
          title="Стиль подачи"
          hint="Свободная инструкция для движка: «дружный», «спокойно», «бодро». Пусто — без неё."
        >
          <input
            value={tts.style}
            onChange={(event) => onTtsChange({ style: event.target.value })}
            placeholder="дружный"
          />
        </Row>
        <Row
          stacked
          title="Ключ синтеза"
          hint={
            speech?.keyConfigured
              ? 'Ключ лежит в Keychain и никогда не показывается целиком.'
              : 'Отдельный ключ для этого endpoint. Не тот, что у модели, если сервисы разные.'
          }
        >
          {speech?.keyConfigured ? (
            <div className="row-actions">
              <span className="permission-state ok">● Ключ сохранён</span>
              <button className="ghost" onClick={onRemoveKey}>
                Удалить
              </button>
            </div>
          ) : (
            <div className="row-actions">
              <input
                type="password"
                value={ttsKey}
                onChange={(event) => onTtsKeyInput(event.target.value)}
                placeholder="sk-…"
                onKeyDown={(event) => {
                  if (event.key === 'Enter') onSaveKey()
                }}
              />
              <button disabled={!ttsKey.trim()} onClick={onSaveKey}>
                Сохранить
              </button>
            </div>
          )}
        </Row>
        <Row
          title="Проверка"
          hint={
            previewError
              ? previewError
              : !speech?.configured
                ? (speech?.reason ?? 'Заполни адрес, модель, голос и ключ.')
                : speech.reason
                  ? `Последний синтез не удался: ${speech.reason}`
                  : 'Прозвучит короткий пример текущим голосом.'
          }
        >
          <button
            disabled={previewing || !speech?.configured}
            onClick={onPreview}
          >
            {previewing ? 'Играет…' : 'Прослушать пример'}
          </button>
        </Row>
      </Group>
    </>
  )
}

interface ReadinessSectionProps {
  /** The model the settings point at, and the one the process has loaded. */
  model: string
  savedModel: string
  status: VoiceStatus | null
  testError: string | null
  checking: boolean
  onCheck(): void
}

/** Whether the machine can actually record and recognise right now. */
function ReadinessSection({
  model,
  savedModel,
  status,
  testError,
  checking,
  onCheck
}: ReadinessSectionProps) {
  const ready = status?.ready ?? false

  return (
    <Group title="Состояние">
      <Row
        title={ready ? 'Готово' : 'Не готово'}
        hint={
          model !== savedModel
            ? 'Применяем модель…'
            : (status?.detail ?? 'Проверка…')
        }
      >
        <div className="row-actions">
          {ready && <span className="permission-state ok">● Всё на месте</span>}
          <button disabled={checking} onClick={onCheck}>
            {checking ? 'Проверка…' : 'Проверить'}
          </button>
        </div>
      </Row>
      {status?.listenerError && (
        <Row stacked>
          <div className="row-hint err">{status.listenerError}</div>
        </Row>
      )}
      {testError && (
        <Row stacked>
          <div className="row-hint err">{testError}</div>
        </Row>
      )}
      {status?.modelPath && (
        <Row stacked>
          <div className="mono">{status.modelPath}</div>
        </Row>
      )}
    </Group>
  )
}

export function VoiceTab({ voice, tts, savedModel, onVoiceChange, onTtsChange }: VoiceTabProps) {
  const [status, setStatus] = useState<VoiceStatus | null>(null)
  const [speech, setSpeech] = useState<TtsStatus | null>(null)
  const [ttsKey, setTtsKeyInput] = useState('')
  const [previewing, setPreviewing] = useState(false)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const previewAudio = useRef<HTMLAudioElement | null>(null)
  const [deleting, setDeleting] = useState<string | null>(null)
  const [progress, setProgress] = useState<DownloadProgress | null>(null)
  const [downloadError, setDownloadError] = useState<string | null>(null)
  const [testError, setTestError] = useState<string | null>(null)
  const [checking, setChecking] = useState(false)

  const refreshVoice = useCallback(() => {
    void window.deskhand.voice
      .status()
      .then(setStatus)
      .catch(() => setStatus(null))
  }, [])

  useEffect(() => {
    refreshVoice()
  }, [refreshVoice, savedModel])

  // Whether live synthesis is configured. Re-read when the endpoint changes, so
  // the pane never claims a voice it no longer has.
  const refreshTts = useCallback(() => {
    void window.deskhand.tts.status().then(setSpeech).catch(() => setSpeech(null))
  }, [])

  useEffect(() => {
    refreshTts()
  }, [refreshTts, tts.enabled, tts.baseUrl, tts.model, tts.voice])

  useEffect(() => window.deskhand.voice.onDownloadProgress((event) => {
    if (event.error) setDownloadError(event.error)
    if (!event.done) setProgress(event)
  }), [])

  const installed = useMemo(() => new Set(status?.installed ?? []), [status])

  const download = useCallback(
    async (id: string) => {
      setDownloadError(null)
      setProgress({ model: id, received: 0, total: 0, done: false })
      try {
        setStatus(await window.deskhand.voice.download(id))
      } catch {
        setDownloadError('Не удалось скачать модель. Проверь соединение и попробуй снова.')
      } finally {
        setProgress(null)
      }
    },
    []
  )

  async function importModel(): Promise<void> {
    setDownloadError(null)
    try {
      const next = await window.deskhand.voice.importModel()
      if (next) setStatus(next)
    } catch {
      setDownloadError('Не удалось импортировать модель. Попробуй снова.')
    }
  }

  async function remove(id: string, label: string): Promise<void> {
    if (!window.confirm(`Удалить модель «${label}» с этого Mac?`)) return
    setDownloadError(null)
    setDeleting(id)
    try {
      setStatus(await window.deskhand.voice.deleteModel(id))
    } catch {
      setDownloadError('Не удалось удалить модель. Попробуй снова.')
    } finally {
      setDeleting(null)
    }
  }

  const testVoice = useCallback(async () => {
    setChecking(true)
    try {
      const result = await window.deskhand.voice.test()
      setTestError(result.ok ? null : (result.message ?? 'Голосовой ввод не готов.'))
      refreshVoice()
    } catch (error) {
      setTestError(error instanceof Error ? error.message : 'Голосовой ввод не готов.')
    } finally {
      setChecking(false)
    }
  }, [refreshVoice])

  const selected = voiceModel(voice.model)

  /** Stores the synthesis key; the value never comes back from the main process. */
  const saveTtsKey = useCallback(async () => {
    if (!ttsKey.trim()) return
    setSpeech(await window.deskhand.tts.setKey(ttsKey.trim()))
    setTtsKeyInput('')
  }, [ttsKey])

  const removeTtsKey = useCallback(async () => {
    setSpeech(await window.deskhand.tts.deleteKey())
  }, [])

  /** Plays one fixed line in the configured voice, so the choice can be judged. */
  const previewVoice = useCallback(async () => {
    setPreviewing(true)
    setPreviewError(null)
    try {
      const result = await window.deskhand.tts.preview()
      if (!result.ok) {
        setPreviewError(result.message)
        return
      }
      previewAudio.current?.pause()
      const element = new Audio(`data:audio/mpeg;base64,${result.audio}`)
      previewAudio.current = element
      element.onended = () => setPreviewing(false)
      element.onerror = () => {
        setPreviewing(false)
        setPreviewError('Не удалось воспроизвести пример.')
      }
      await element.play()
    } catch (error) {
      setPreviewing(false)
      setPreviewError(error instanceof Error ? error.message : 'Не удалось получить пример.')
    } finally {
      refreshTts()
    }
  }, [refreshTts])

  useEffect(() => () => previewAudio.current?.pause(), [])

  return (
    <div className="pane">
      <Group title="Ввод">
        <ToggleRow
          title="Включить голосовой ввод"
          hint="Удерживай клавишу. Распознавание локальное — звук не покидает Mac."
          checked={voice.enabled}
          onChange={(enabled) => onVoiceChange({ enabled })}
        />
      </Group>

      <Group title="Распознавание">
        <Row
          stacked
          title="Что делать с распознанным"
          hint={
            voice.action === 'command'
              ? 'Речь станет запросом к модели вместе с контекстом окна — как набранный текст.'
              : 'Речь вставится в то поле, где стоял курсор. Карточка при этом закроется.'
          }
        >
          <div className="segmented">
            <button
              className={voice.action === 'command' ? 'active' : ''}
              onClick={() => onVoiceChange({ action: 'command' })}
            >
              Спросить модель
            </button>
            <button
              className={voice.action === 'dictate' ? 'active' : ''}
              onClick={() => onVoiceChange({ action: 'dictate' })}
            >
              Напечатать в приложении
            </button>
          </div>
        </Row>

        {voice.action === 'command' && (
          <ToggleRow
            title="Отправлять не дожидаясь Enter"
            hint="Ответ начнётся сразу, как только речь распознана."
            checked={voice.autoSend}
            onChange={(autoSend) => onVoiceChange({ autoSend })}
          />
        )}

        <Row
          title="Язык речи"
          hint={
            selected?.language
              ? 'У выбранной модели фиксированный язык.'
              : 'Для коротких команд язык надёжнее автоопределения.'
          }
        >
          <select
            value={selected?.language ?? voice.language}
            disabled={Boolean(selected?.language)}
            aria-label="Язык речи"
            onChange={(event) => onVoiceChange({ language: event.target.value })}
          >
            {WHISPER_LANGUAGES.map((language) => (
              <option key={language.id} value={language.id}>
                {language.label}
              </option>
            ))}
          </select>
        </Row>

        <ModelList
          model={voice.model}
          installed={installed}
          progress={progress}
          deleting={deleting}
          downloadError={downloadError}
          onPick={(id) => onVoiceChange({ model: id })}
          onDownload={(id) => void download(id)}
          onImport={() => void importModel()}
          onRemove={(id, label) => void remove(id, label)}
        />
      </Group>

      <TtsSection
        voice={voice}
        tts={tts}
        speech={speech}
        ttsKey={ttsKey}
        previewing={previewing}
        previewError={previewError}
        onVoiceChange={onVoiceChange}
        onTtsChange={onTtsChange}
        onTtsKeyInput={setTtsKeyInput}
        onSaveKey={() => void saveTtsKey()}
        onRemoveKey={() => void removeTtsKey()}
        onPreview={() => void previewVoice()}
      />

      <ReadinessSection
        model={voice.model}
        savedModel={savedModel}
        status={status}
        testError={testError}
        checking={checking}
        onCheck={() => void testVoice()}
      />
    </div>
  )
}
