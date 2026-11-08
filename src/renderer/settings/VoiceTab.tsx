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

import { useCallback, useEffect, useMemo, useState } from 'react'
import type {
  DownloadProgress,
  GestureSettings,
  VoiceSettings,
  VoiceStatus
} from '@shared/types'
import { WHISPER_LANGUAGES, VOICE_MODELS, voiceModel } from '@shared/defaults'
import { Group, Row, ToggleRow } from './Row'

interface VoiceTabProps {
  voice: VoiceSettings
  savedModel: string
  gestures: GestureSettings
  onChange(changes: Partial<VoiceSettings>): void
  onGestureChange(changes: Partial<GestureSettings>): void
}

function megabytes(bytes: number): string {
  if (bytes > 0 && bytes < 1024 * 1024) return '< 1 МБ'
  return `${Math.round(bytes / (1024 * 1024))} МБ`
}

export function VoiceTab({ voice, savedModel, gestures, onChange, onGestureChange }: VoiceTabProps) {
  const [status, setStatus] = useState<VoiceStatus | null>(null)
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

  return (
    <div className="pane">
      <Group title="Ввод">
        <ToggleRow
          title="Включить голосовой ввод"
          hint="Удерживайте клавишу или три пальца на трекпаде. Распознавание локальное — звук не покидает Mac."
          checked={voice.enabled}
          onChange={(enabled) => onChange({ enabled })}
        />

        <ToggleRow
          title="Три пальца на трекпаде"
          hint="Короткое касание открывает карточку, удержание записывает речь."
          checked={gestures.enabled}
          onChange={(enabled) => onGestureChange({ enabled })}
        />

        {gestures.enabled && (
          <Row
            title="Граница «касание / удержание»"
            hint={`${gestures.holdMs} мс. Короче — случайное касание начнёт запись.`}
          >
            <input
              type="range"
              min={250}
              max={900}
              step={10}
              value={gestures.holdMs}
              aria-label="Граница между касанием и удержанием"
              onChange={(event) => onGestureChange({ holdMs: Number(event.target.value) })}
            />
          </Row>
        )}

        {status?.gestureError && (
          <Row stacked>
            <div className="row-hint err">{status.gestureError}</div>
          </Row>
        )}
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
                    <span className="model-name">{model.label}</span>
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
          hint="Системным голосом подтверждать долгую обработку. Не чаще раза в 45 секунд."
          checked={voice.agentFeedback}
          onChange={(agentFeedback) => onChange({ agentFeedback })}
        />
        <ToggleRow
          title="Голосовой диалог"
          hint="Озвучивать ответы на голосовые вопросы. Текстовые — кнопкой «Прослушать»."
          checked={voice.dialogue}
          onChange={(dialogue) => onChange({ dialogue })}
        />
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
