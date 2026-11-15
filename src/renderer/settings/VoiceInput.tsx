import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { DownloadProgress, VoiceSettings, VoiceStatus } from '@shared/types'
import { BUNDLED_VOICE_MODEL, WHISPER_LANGUAGES, WHISPER_MODELS, voiceModel } from '@shared/defaults'
import { Disclosure, Group, Row, ToggleRow } from './Row'
import { InstallList } from './InstallList'
import { HotkeyField } from './HotkeyField'
import { MicrophoneCheck } from './MicrophoneCheck'

interface VoiceInputProps {
  active: boolean
  microphoneGranted: boolean
  onOpenMicrophoneSettings(): void
  voice: VoiceSettings
  savedVoice: VoiceSettings
  onVoiceChange(changes: Partial<VoiceSettings>): void
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

export function VoiceInput({
  active,
  voice,
  savedVoice,
  microphoneGranted,
  onOpenMicrophoneSettings,
  onVoiceChange
}: VoiceInputProps) {
  const {
    model: savedModel,
    enabled: savedVoiceEnabled,
    hotkey: savedHotkey,
    dictationHotkey: savedDictationHotkey
  } = savedVoice

  const [status, setStatus] = useState<VoiceStatus | null>(null)

  const [deleting, setDeleting] = useState<string | null>(null)
  const [progress, setProgress] = useState<DownloadProgress | null>(null)
  const [downloadError, setDownloadError] = useState<string | null>(null)

  const voiceStatusRequest = useRef(0)

  const refreshVoice = useCallback(() => {
    const request = ++voiceStatusRequest.current
    void window.deskhand.voice
      .status()
      .then((next) => {
        if (request === voiceStatusRequest.current) setStatus(next)
      })
      .catch(() => {
        if (request === voiceStatusRequest.current) setStatus(null)
      })
  }, [])

  useEffect(() => {
    refreshVoice()
  }, [refreshVoice, savedModel, savedVoiceEnabled, savedHotkey, savedDictationHotkey])

  useEffect(
    () =>
      window.deskhand.voice.onDownloadProgress((event) => {
        if (event.error) setDownloadError(event.error)
        if (!event.done) setProgress(event)
      }),
    []
  )

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

  // Reflect a click on an installed model while its settings are being saved.
  const selectedModel = installed.has(voice.model) ? voice.model : (status?.activeModel ?? null)
  const selected = voiceModel(selectedModel ?? '')
  const modelName = selected?.label ?? selectedModel

  /**
   * What the command key does after recognition.
   *
   * Named as a mode rather than as a select value: the option text is the
   * consequence ("показать", "отправить", "вставить"), and the hint under the
   * row explains what that means for the card and the cursor.
   */
  const commandMode = voice.action === 'dictate' ? 'dictate' : voice.autoSend ? 'send' : 'review'
  const commandHint =
    commandMode === 'review'
      ? 'Откроется карточка с текстом. Проверишь и отправишь сам.'
      : commandMode === 'send'
        ? 'Карточка откроется и сразу отправит запрос модели.'
        : 'Текст вставится в поле. Обе клавиши будут делать одно и то же.'

  return (
    <>
      <MicrophoneCheck visible={active} onOpenMicrophoneSettings={onOpenMicrophoneSettings} />
      <Group title="Голосовые клавиши" footnote="Команда — это вопрос ассистенту. Диктовка — это текст в текущее поле.">
        <ToggleRow
          title="Голосовой ввод"
          hint="Выключение отключает обе клавиши."
          checked={voice.enabled}
          onChange={(enabled) => onVoiceChange({ enabled })}
        />
        <Row title="Клавиша команды" hint="Удерживай и говори — текст попадёт в карточку.">
          <HotkeyField value={voice.hotkey} allowModifiersOnly onChange={(hotkey) => onVoiceChange({ hotkey })} />
        </Row>
        <Row title="Клавиша диктовки" hint="Удерживай и говори — текст появится там, где стоит курсор.">
          <HotkeyField
            value={voice.dictationHotkey}
            allowModifiersOnly
            onChange={(dictationHotkey) => onVoiceChange({ dictationHotkey })}
          />
        </Row>
        <Row title="Что делает клавиша команды" hint={commandHint}>
          <select
            aria-label="Что делает клавиша команды"
            value={commandMode}
            onChange={(event) => {
              const action = event.target.value
              onVoiceChange(
                action === 'dictate' ? { action: 'dictate' } : { action: 'command', autoSend: action === 'send' }
              )
            }}
          >
            <option value="review">Показать в карточке</option>
            <option value="send">Отправить сразу</option>
            <option value="dictate">Вставить в поле</option>
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
          hint={
            voice.model !== savedModel
              ? 'Применяю модель…'
              : (status?.detail ??
                (selectedModel === BUNDLED_VOICE_MODEL.id
                  ? 'Встроенная модель для русского языка.'
                  : selectedModel
                    ? 'Речь распознаётся на этом Mac.'
                    : 'Проверяю модель…'))
          }
        />
        {selectedModel && selectedModel !== BUNDLED_VOICE_MODEL.id && (
          <Row title="Язык речи">
            <select
              value={voice.language}
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
        )}
        <Disclosure title="Управление моделями">
          {voice.model !== BUNDLED_VOICE_MODEL.id && installed.has(BUNDLED_VOICE_MODEL.id) && (
            <Row title={BUNDLED_VOICE_MODEL.label} hint="Встроенная модель для русского языка.">
              <button
                disabled={progress !== null || deleting !== null}
                onClick={() => onVoiceChange({ model: BUNDLED_VOICE_MODEL.id })}
              >
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
    </>
  )
}
