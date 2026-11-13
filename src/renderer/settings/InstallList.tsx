import { useState } from 'react'
import type { DownloadProgress } from '@shared/types'
import { Row } from './Row'

const BYTES_PER_MB = 1024 * 1024

function megabytes(bytes: number): string {
  if (bytes > 0 && bytes < BYTES_PER_MB) return '< 1 МБ'
  return `${Math.round(bytes / BYTES_PER_MB)} МБ`
}

export interface InstallEntry {
  id: string
  label: string
  meta: string
}

interface InstallListProps {
  entries: readonly InstallEntry[]
  active: string | null
  installed: ReadonlySet<string>
  progress: DownloadProgress | null
  deleting: string | null
  error: string | null
  extras: readonly string[]
  onPick(id: string): void
  onDownload(id: string): void
  onImport(): void
  onRemove(id: string, label: string): void
}

export function InstallList({
  entries, active, installed, progress, deleting, error, extras, onPick, onDownload, onImport, onRemove
}: InstallListProps) {
  const [downloadId, setDownloadId] = useState('')
  const ready = [
    ...entries.filter(({ id }) => installed.has(id)),
    ...extras.map((id) => ({ id, label: id }))
  ]
  const available = entries.filter(({ id }) => !installed.has(id))
  const selected = available.find(({ id }) => id === (progress?.model ?? downloadId))
  const busy = progress !== null || deleting !== null

  return (
    <>
      {ready.length > 0 && (
        <Row stacked title="Установленные модели Whisper">
          <div className="models">
            {ready.map(({ id, label }) => (
              <div key={id} className="model-row" data-active={active === id}>
                <span className="model-name">{label}</span>
                <div className="model-actions">
                  {active === id
                    ? <span className="model-state ok">Активна</span>
                    : <button className="model-state" disabled={busy} onClick={() => onPick(id)}>Использовать</button>}
                  <button className="model-state" disabled={busy} aria-label={`Удалить ${label}`}
                    onClick={() => onRemove(id, label)}>
                    {deleting === id ? 'Удаляю…' : 'Удалить'}
                  </button>
                </div>
              </div>
            ))}
          </div>
        </Row>
      )}
      {available.length > 0 && (
        <Row stacked title="Скачать модель Whisper" hint={selected?.meta ?? 'Whisper распознаёт речь на разных языках.'}>
          <div className="row-actions">
            <select aria-label="Модель Whisper для скачивания" disabled={busy} value={selected?.id ?? ''}
              onChange={(event) => setDownloadId(event.target.value)}>
              <option value="" disabled>Выбери модель</option>
              {available.map(({ id, label }) => <option key={id} value={id}>{label}</option>)}
            </select>
            <button disabled={busy || !selected} onClick={() => { if (selected) onDownload(selected.id) }}>Скачать</button>
          </div>
          {progress && (
            <div className="row-hint" role="status">
              {progress.total > 0
                ? `${megabytes(progress.received)} из ${megabytes(progress.total)}`
                : progress.received > 0 ? megabytes(progress.received) : 'Подключаюсь…'}
            </div>
          )}
        </Row>
      )}
      {error && <Row hint={<span className="row-hint err" role="alert">{error}</span>} />}
      <Row title="Файл модели" hint="Импортируй модель Whisper с этого Mac.">
        <button disabled={busy} onClick={onImport}>Импортировать модель Whisper</button>
      </Row>
    </>
  )
}
