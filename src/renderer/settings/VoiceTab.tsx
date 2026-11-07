/**
 * The "Голос" settings tab.
 *
 * Everything here is about one promise: hold a key, speak, get an answer without
 * the audio leaving the machine. That makes the section mostly a readiness panel —
 * which whisper model is on disk, how big it is, whether the keyboard tap could
 * start — because those are the only things that can actually be wrong.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import type {
  DownloadProgress,
  GestureSettings,
  VoiceSettings,
  VoiceStatus
} from '@shared/types'
import { WHISPER_LANGUAGES, VOICE_MODELS, voiceModel } from '@shared/defaults'
import { HotkeyField, prettyHotkey } from './HotkeyField'

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

  return (
    <section>
      <h2>Голос</h2>
      <div className="field">
        <label>
          <input type="checkbox" checked={voice.agentFeedback}
            onChange={(event) => onChange({ agentFeedback: event.target.checked })} />
          Короткие реплики агента
        </label>
        <p className="hint">Подтверждать долгую обработку голосовой команды системным голосом.
          Не чаще раза в 45 секунд. Для озвучки нужен русский голос macOS.</p>
      </div>
      <div className="field">
        <label>
          <input type="checkbox" checked={voice.dialogue}
            onChange={(event) => onChange({ dialogue: event.target.checked })} />
          Голосовой диалог
        </label>
        <p className="hint">Коротко озвучивать ответы на голосовые вопросы системным голосом.
          Для текстовых запросов используйте кнопку «Прослушать».</p>
      </div>
      <p className="hint">
        Удерживайте клавишу или три пальца на трекпаде, говорите, отпустите. Распознавание идёт
        локально на этом Mac — звук никуда не отправляется.
      </p>

      <div className="field">
        <label>
          <input
            type="checkbox"
            checked={voice.enabled}
            onChange={(event) => onChange({ enabled: event.target.checked })}
          />{' '}
          Включить голосовой ввод
        </label>
      </div>

      <div className="field">
        <label>
          <input
            type="checkbox"
            checked={gestures.enabled}
            onChange={(event) => onGestureChange({ enabled: event.target.checked })}
          />{' '}
          Три пальца на трекпаде
        </label>
        <div className="hint">
          Короткое касание тремя пальцами открывает карточку — как горячая клавиша. Удержание
          трёх пальцев записывает речь: отпустили — распознали. Клавиши работают как раньше,
          жест только добавляет способ.
        </div>
        {gestures.enabled && (
          <>
            <div className="field">
              <label>Граница «касание / удержание» · {gestures.holdMs} мс</label>
              <input
                type="range"
                min={250}
                max={900}
                step={10}
                value={gestures.holdMs}
                onChange={(event) => onGestureChange({ holdMs: Number(event.target.value) })}
              />
              <div className="hint">
                Короче — и случайное касание начнёт записывать; длиннее — и придётся держать
                пальцы дольше, прежде чем откроется микрофон.
              </div>
            </div>
          </>
        )}
        {status?.gestureError && <div className="hint err">{status.gestureError}</div>}
      </div>

      <div className="field">
        <label>Клавиша удержания</label>
        <HotkeyField value={voice.hotkey} onChange={(hotkey) => onChange({ hotkey })} />
        <div className="hint">
          Сейчас: {prettyHotkey(voice.hotkey)}. Комбинация перехватывается приложением — в
          других программах она не сработает. Esc во время записи отменяет её.
        </div>
      </div>

      <div className="field">
        <label>Что делать с распознанным</label>
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
        <div className="hint">
          {voice.action === 'command'
            ? 'Речь станет запросом к модели вместе с контекстом окна — как набранный текст.'
            : 'Речь вставится в то поле, где стоял курсор. Карточка при этом закроется.'}
        </div>
      </div>

      {voice.action === 'command' && (
        <div className="field">
          <label>
            <input
              type="checkbox"
              checked={voice.autoSend}
              onChange={(event) => onChange({ autoSend: event.target.checked })}
            />{' '}
            Отправлять автоматически, не дожидаясь Enter
          </label>
        </div>
      )}

      <div className="field">
        <label>Язык речи</label>
        <select
          value={selected?.language ?? voice.language}
          disabled={Boolean(selected?.language)}
          onChange={(event) => onChange({ language: event.target.value })}
        >
          {WHISPER_LANGUAGES.map((language) => (
            <option key={language.id} value={language.id}>
              {language.label}
            </option>
          ))}
        </select>
        <div className="hint">
          {selected?.language
            ? 'У выбранной модели фиксированный язык распознавания.'
            : 'Для коротких команд указанный язык надёжнее автоопределения.'}
        </div>
      </div>

      <div className="field">
        <label>Модель распознавания</label>
        {downloadError && <div className="hint err" role="alert">{downloadError}</div>}
        <div className="models">
          {VOICE_MODELS.map((model) => {
            const ready = installed.has(model.id)
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
                {ready ? (
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
                  <button className="model-state" disabled={progress !== null || deleting !== null} onClick={() => void download(model.id)}>
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
        <div className="hint">
          {selected
            ? `Выбрана «${selected.label}» — ${selected.note}`
            : 'Модель не выбрана.'}
        </div>
        <button
          className="ghost"
          disabled={progress !== null || deleting !== null}
          onClick={() => void importModel()}
        >
          Указать файл ggml-*.bin вручную
        </button>
      </div>

      <div className="field">
        <label>Состояние</label>
        <div className="hint">
          {voice.model !== savedModel ? 'Применяем модель…' : status?.ready ? 'Всё готово: модель и движок на месте.' : (status?.detail ?? 'Проверка…')}
        </div>
        {status?.listenerError && <div className="hint err">{status.listenerError}</div>}
        {status?.modelPath && <div className="hint mono">{status.modelPath}</div>}
        <div className="spacer-row">
          <button disabled={checking} onClick={() => void check()}>
            {checking ? 'Проверка…' : 'Проверить готовность'}
          </button>
          <button className="ghost" onClick={refresh}>
            Обновить
          </button>
        </div>
        {error && <div className="hint err">{error}</div>}
      </div>

      <div className="field">
        <label>Точность срабатывания</label>
        <div className="hint">
          Слишком короткое нажатие ({voice.minDurationMs} мс) считается случайным и не
          записывается. Запись обрывается на {Math.round(voice.maxDurationMs / 1000)} с.
        </div>
      </div>
    </section>
  )
}
