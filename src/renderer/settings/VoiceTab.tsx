/**
 * The "Голос" settings tab.
 *
 * Everything here is about one promise: hold a key, speak, get an answer without
 * the audio leaving the machine. That makes the section mostly a readiness panel —
 * which model is active and whether the keyboard tap could start.
 *
 * The pane is the tab's own state and handlers; the cards that only read it are
 * three components below: `ModelList` (which models are on disk), `TtsSection`
 * (how the assistant sounds) and `ReadinessSection` (whether it can run at all).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { DownloadProgress, TtsSettings, TtsStatus, VoiceSettings, VoiceStatus } from '@shared/types'
import {
  WHISPER_LANGUAGES,
  BUNDLED_VOICE_MODEL,
  WHISPER_MODELS,
  voiceModel
} from '@shared/defaults'
import { Disclosure, Group, Row, ToggleRow } from './Row'
import { InstallList } from './InstallList'

interface VoiceTabProps {
  voice: VoiceSettings
  tts: TtsSettings
  savedModel: string
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
  applying: boolean
  progress: DownloadProgress | null
  deleting: string | null
  downloadError: string | null
  onPick(id: string): void
  onDownload(id: string): void
  onImport(): void
  onRemove(id: string, label: string): void
}

/** Which recognition models are on disk, and the ways to get more of them. */
function ModelList({ activeModel, installed, applying, progress, deleting, downloadError, ...handlers }: ModelListProps) {
  return (
    <InstallList
      title="Модели Whisper"
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
      hint={applying ? 'Применяем модель…' : 'Whisper поддерживает другие языки.'}
      importLabel="Импортировать модель Whisper"
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
  applying,
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
  const answerName = speech?.voice || tts.voice

  const previewHint = previewError ?? (
    !speech?.configured
      ? (speech?.reason ?? 'Включи синтез, чтобы прослушать пример.')
      : speech.reason
        ? `Последний синтез не удался: ${speech.reason}`
        : 'Прозвучит короткий пример текущим голосом.'
  )

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
          title="Автоматическая озвучка ответа"
          hint={
            voice.answerVoice === 'off'
              ? 'Кнопка «Прослушать» использует настроенный голос, если синтез включён.'
              : voice.answerVoice === 'system'
                ? 'Системный голос macOS: бесплатно, офлайн, без ключа.'
                : speech?.configured
                  ? tts.engine === 'piper'
                    ? 'Локальный голос «Руслан». Офлайн, без ключа и оплаты.'
                    : `Нейроголос «${answerName}». Готовые фрагменты сохраняются в кэше.`
                  : 'Голос не настроен — ответ прочитает системный голос.'
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
          hint={
            tts.engine === 'piper'
              ? 'Локальный голос: файлы лежат на этом Mac, сеть и ключ не нужны.'
              : 'Endpoint, модель, голос и стиль — твои. Ключ хранится в Keychain и не показывается.'
          }
          checked={tts.enabled}
          onChange={(enabled) => onTtsChange({ enabled })}
        />
        <Row
          stacked
          title="Движок"
          hint={
            tts.engine === 'piper'
              ? 'Руслан уже в приложении. Работает офлайн без ключа.'
              : 'OpenAI-совместимый сервис синтеза: ключ и адрес задаёшь сам.'
          }
        >
          <div className="segmented">
            <button
              className={tts.engine === 'piper' ? 'active' : ''}
              onClick={() => onTtsChange({ engine: 'piper', enabled: true })}
            >
              Piper · Руслан
            </button>
            <button
              className={tts.engine === 'remote' ? 'active' : ''}
              onClick={() => onTtsChange({ engine: 'remote' })}
            >
              Сервис по API
            </button>
          </div>
        </Row>

        {tts.engine === 'remote' && (
          <>
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
          </>
        )}

        <Row title="Проверка" hint={applying ? 'Применяем настройки синтеза…' : previewHint}>
          <button
            disabled={applying || previewing || !speech?.configured}
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
        title={status === null ? 'Проверяем…' : ready ? 'Готово' : 'Не готово'}
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
    </Group>
  )
}

export function VoiceTab({ voice, tts, savedModel, savedTts, onVoiceChange, onTtsChange }: VoiceTabProps) {
  const [status, setStatus] = useState<VoiceStatus | null>(null)
  const [speech, setSpeech] = useState<TtsStatus | null>(null)
  const [ttsKey, setTtsKeyInput] = useState('')
  const [previewing, setPreviewing] = useState(false)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const previewAudio = useRef<HTMLAudioElement | null>(null)
  const previewGeneration = useRef(0)
  const [deleting, setDeleting] = useState<string | null>(null)
  const [progress, setProgress] = useState<DownloadProgress | null>(null)
  const [downloadError, setDownloadError] = useState<string | null>(null)
  const [testError, setTestError] = useState<string | null>(null)
  const [checking, setChecking] = useState(false)
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
  }, [refreshVoice, savedModel])

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

  /** Plays one fixed line in the configured voice, so the choice can be judged. */
  const previewVoice = useCallback(async () => {
    const generation = ++previewGeneration.current
    setPreviewing(true)
    setPreviewError(null)
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
  }, [refreshTts])

  useEffect(() => {
    setPreviewing(false)
    setPreviewError(null)
    return () => {
      previewGeneration.current++
      const element = previewAudio.current
      if (!element) return
      element.onended = null
      element.onerror = null
      element.pause()
      previewAudio.current = null
    }
  }, [ttsConfig])

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
          title="Модель распознавания"
          hint={
            voice.model !== savedModel
              ? 'Применяем модель…'
              : selectedModel === BUNDLED_VOICE_MODEL.id || !status
                ? `${BUNDLED_VOICE_MODEL.label} · встроенная модель для русского языка.`
                : modelName ? `Используется «${modelName}».` : (status.detail ?? 'Модель недоступна.')
          }
        >
          {voice.model !== BUNDLED_VOICE_MODEL.id && installed.has(BUNDLED_VOICE_MODEL.id) && (
            <button disabled={progress !== null || deleting !== null} onClick={() => onVoiceChange({ model: BUNDLED_VOICE_MODEL.id })}>
              Выбрать GigaAM
            </button>
          )}
        </Row>
      </Group>

      <Disclosure title="Другие модели распознавания">
        <ModelList
          activeModel={selectedModel}
          installed={installed}
          applying={voice.model !== savedModel}
          progress={progress}
          deleting={deleting}
          downloadError={downloadError}
          onPick={(id) => onVoiceChange({ model: id })}
          onDownload={(id) => void download(id)}
          onImport={() => void importModel()}
          onRemove={(id, label) => void remove(id, label)}
        />
        {selectedModel && selectedModel !== BUNDLED_VOICE_MODEL.id && (
          <Row title="Язык речи" hint="Для коротких команд язык надёжнее автоопределения.">
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
      </Disclosure>

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
