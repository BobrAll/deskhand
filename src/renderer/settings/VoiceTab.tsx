/**
 * The "Голос" settings tab.
 *
 * Everything here is about one promise: hold a key, speak, get an answer without
 * the audio leaving the machine. That makes the section mostly a readiness panel —
 * which whisper model is on disk, how big it is, whether the keyboard tap could
 * start — because those are the only things that can actually be wrong.
 *
 * Three cards, in the order the work happens: how you start talking, what is done
 * with the words, and whether the machine is ready to do either.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { DownloadProgress, TtsSettings, TtsStatus, VoiceSettings, VoiceStatus } from '@shared/types'
import { WHISPER_LANGUAGES, VOICE_MODELS, voiceModel } from '@shared/defaults'
import { Group, Row, ToggleRow } from './Row'

interface VoiceTabProps {
  voice: VoiceSettings
  tts: TtsSettings
  savedModel: string
  onChange(changes: Partial<VoiceSettings>): void
  onTtsChange(changes: Partial<TtsSettings>): void
}

function megabytes(bytes: number): string {
  if (bytes > 0 && bytes < 1024 * 1024) return '< 1 МБ'
  return `${Math.round(bytes / (1024 * 1024))} МБ`
}

export function VoiceTab({ voice, tts, savedModel, onChange, onTtsChange }: VoiceTabProps) {
  const [status, setStatus] = useState<VoiceStatus | null>(null)
  const [speech, setSpeech] = useState<TtsStatus | null>(null)
  const [ttsKey, setTtsKeyInput] = useState('')
  const [previewing, setPreviewing] = useState(false)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const previewAudio = useRef<HTMLAudioElement | null>(null)
  const [deleting, setDeleting] = useState<string | null>(null)
  const [progress, setProgress] = useState<DownloadProgress | null>(null)
  const [downloadError, setDownloadError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [checking, setChecking] = useState(false)

  const refresh = useCallback(() => {
    void window.smartCursor.voice
      .status()
      .then(setStatus)
      .catch(() => setStatus(null))
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh, savedModel])

  // Whether live synthesis is configured. Re-read when the endpoint changes, so
  // the pane never claims a voice it no longer has.
  const refreshSpeech = useCallback(() => {
    void window.smartCursor.tts.status().then(setSpeech).catch(() => setSpeech(null))
  }, [])

  useEffect(() => {
    refreshSpeech()
  }, [refreshSpeech, tts.enabled, tts.baseUrl, tts.model, tts.voice])

  useEffect(() => window.smartCursor.voice.onDownloadProgress((event) => {
    if (event.error) setDownloadError(event.error)
    if (!event.done) setProgress(event)
  }), [])

  const installed = useMemo(() => new Set(status?.installed ?? []), [status])

  const download = useCallback(
    async (id: string) => {
      setDownloadError(null)
      setProgress({ model: id, received: 0, total: 0, done: false })
      try {
        setStatus(await window.smartCursor.voice.download(id))
      } catch {
        setDownloadError('Не удалось скачать модель. Проверьте соединение и попробуйте снова.')
      } finally {
        setProgress(null)
      }
    },
    []
  )

  async function importModel(): Promise<void> {
    const next = await window.smartCursor.voice.importModel()
    if (next) setStatus(next)
  }

  async function remove(id: string, label: string): Promise<void> {
    if (!window.confirm(`Удалить модель «${label}» с этого Mac?`)) return
    setDownloadError(null)
    setDeleting(id)
    try {
      setStatus(await window.smartCursor.voice.deleteModel(id))
    } catch {
      setDownloadError('Не удалось удалить модель. Попробуйте снова.')
    } finally {
      setDeleting(null)
    }
  }

  function deleteButton(id: string, label: string) {
    return (
      <button
        className="model-state"
        disabled={deleting !== null || progress !== null}
        aria-label={`Удалить ${label}`}
        onClick={() => void remove(id, label)}
      >
        {deleting === id ? 'Удаляем…' : 'Удалить'}
      </button>
    )
  }

  const check = useCallback(async () => {
    setChecking(true)
    try {
      const result = await window.smartCursor.voice.test()
      setError(result.ok ? null : (result.message ?? 'Голосовой ввод не готов.'))
      refresh()
    } finally {
      setChecking(false)
    }
  }, [refresh])

  const selected = voiceModel(voice.model)
  const ready = status?.ready ?? false

  /** Stores the synthesis key; the value never comes back from the main process. */
  const saveTtsKey = useCallback(async () => {
    if (!ttsKey.trim()) return
    setSpeech(await window.smartCursor.tts.setKey(ttsKey.trim()))
    setTtsKeyInput('')
  }, [ttsKey])

  const removeTtsKey = useCallback(async () => {
    setSpeech(await window.smartCursor.tts.deleteKey())
  }, [])

  /** Plays one fixed line in the configured voice, so the choice can be judged. */
  const preview = useCallback(async () => {
    setPreviewing(true)
    setPreviewError(null)
    try {
      const result = await window.smartCursor.tts.preview()
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
      refreshSpeech()
    }
  }, [refreshSpeech])

  useEffect(() => () => previewAudio.current?.pause(), [])

  return (
    <div className="pane">
      <Group title="Ввод">
        <ToggleRow
          title="Включить голосовой ввод"
          hint="Удерживайте клавишу. Распознавание локальное — звук не покидает Mac."
          checked={voice.enabled}
          onChange={(enabled) => onChange({ enabled })}
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
              onClick={() => onChange({ action: 'command' })}
            >
              Спросить модель
            </button>
            <button
              className={voice.action === 'dictate' ? 'active' : ''}
              onClick={() => onChange({ action: 'dictate' })}
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
            onChange={(autoSend) => onChange({ autoSend })}
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
            onChange={(event) => onChange({ language: event.target.value })}
          >
            {WHISPER_LANGUAGES.map((language) => (
              <option key={language.id} value={language.id}>
                {language.label}
              </option>
            ))}
          </select>
        </Row>

        <Row stacked title="Модель распознавания">
          {downloadError && (
            <div className="row-hint err" role="alert">
              {downloadError}
            </div>
          )}
          <div className="models">
            {VOICE_MODELS.map((model) => {
              const modelReady = installed.has(model.id)
              const busy = progress?.model === model.id && !progress.done
              const share = progress && progress.total > 0 ? progress.received / progress.total : 0
              return (
                <div key={model.id} className="model-row" data-active={voice.model === model.id}>
                  <button className="model-pick" onClick={() => onChange({ model: model.id })}>
                    <span className="model-name">
                      {model.label}
                      {model.recommended && <span className="badge">рекомендовано</span>}
                    </span>
                    <span className="model-meta">
                      {model.mb} МБ · {model.note}
                    </span>
                  </button>
                  {modelReady ? (
                    <div className="model-actions">
                      <span className="model-state ok">Готово</span>
                      {deleteButton(model.id, model.label)}
                    </div>
                  ) : busy ? (
                    <span className="model-state">
                      {progress.received > 0
                        ? `${megabytes(progress.received)} из ${megabytes(progress.total)}`
                        : 'Подключение…'}
                    </span>
                  ) : (
                    <button
                      className="model-state"
                      disabled={progress !== null || deleting !== null}
                      onClick={() => void download(model.id)}
                    >
                      Скачать
                    </button>
                  )}
                  {busy && (
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
                {deleteButton(file, file)}
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
              onClick={() => void importModel()}
            >
              Указать файл ggml-*.bin
            </button>
          </div>
        </Row>
      </Group>

      <Group title="Озвучка">
        <ToggleRow
          title="Короткие реплики агента"
          hint="Подтверждать долгую обработку голосом. Не чаще раза в 45 секунд."
          checked={voice.agentFeedback}
          onChange={(agentFeedback) => onChange({ agentFeedback })}
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
              onClick={() => onChange({ answerVoice: 'off' })}
            >
              Не читать
            </button>
            <button
              className={voice.answerVoice === 'system' ? 'active' : ''}
              onClick={() => onChange({ answerVoice: 'system' })}
            >
              Системный
            </button>
            <button
              className={voice.answerVoice === 'neural' ? 'active' : ''}
              onClick={() => onChange({ answerVoice: 'neural' })}
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
          hint="Endpoint, модель, голос и стиль — ваши. Ключ хранится в Keychain и не показывается."
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
              <button className="ghost" onClick={() => void removeTtsKey()}>
                Удалить
              </button>
            </div>
          ) : (
            <div className="row-actions">
              <input
                type="password"
                value={ttsKey}
                onChange={(event) => setTtsKeyInput(event.target.value)}
                placeholder="sk-…"
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void saveTtsKey()
                }}
              />
              <button disabled={!ttsKey.trim()} onClick={() => void saveTtsKey()}>
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
                ? (speech?.reason ?? 'Заполните адрес, модель, голос и ключ.')
                : speech.reason
                  ? `Последний синтез не удался: ${speech.reason}`
                  : 'Прозвучит короткий пример текущим голосом.'
          }
        >
          <button
            disabled={previewing || !speech?.configured}
            onClick={() => void preview()}
          >
            {previewing ? 'Играет…' : 'Прослушать пример'}
          </button>
        </Row>
      </Group>

      <Group title="Состояние">
        <Row
          title={ready ? 'Готово' : 'Не готово'}
          hint={
            voice.model !== savedModel
              ? 'Применяем модель…'
              : (status?.detail ?? 'Проверка…')
          }
        >
          <div className="row-actions">
            {ready && <span className="permission-state ok">● Всё на месте</span>}
            <button disabled={checking} onClick={() => void check()}>
              {checking ? 'Проверка…' : 'Проверить'}
            </button>
          </div>
        </Row>
        {status?.listenerError && (
          <Row stacked>
            <div className="row-hint err">{status.listenerError}</div>
          </Row>
        )}
        {error && (
          <Row stacked>
            <div className="row-hint err">{error}</div>
          </Row>
        )}
        {status?.modelPath && (
          <Row stacked>
            <div className="mono">{status.modelPath}</div>
          </Row>
        )}
      </Group>
    </div>
  )
}
