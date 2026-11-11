/**
 * The list of installable models in the «Голос» pane.
 *
 * Two things are installed the same way — recognition models and local Piper
 * voices — so they share one list: a name, a size, a state («Скачать» / «Готово»
 * / progress) and a delete button. The two callers only supply their catalog,
 * the sentence about the current selection, and what an imported file is called;
 * everything that is about *how* an install looks lives here once.
 *
 * A row that is not on disk cannot be chosen: picking it would store a selection
 * with no file behind it, which is exactly the state that made this pane claim a
 * model that was never there. So the name is only a button once the file is;
 * until then the way to get it is «Скачать» on the same row. A disabled button
 * would also dim the description, and a fresh install has every row like that.
 */

import type { DownloadProgress } from '@shared/types'
import { Row } from './Row'

const BYTES_PER_MB = 1024 * 1024

export function megabytes(bytes: number): string {
  if (bytes > 0 && bytes < BYTES_PER_MB) return '< 1 МБ'
  return `${Math.round(bytes / BYTES_PER_MB)} МБ`
}

export interface InstallEntry {
  id: string
  label: string
  /** Size and description, as one line under the name. */
  meta: string
}

interface InstallListProps {
  title: string
  entries: readonly InstallEntry[]
  /** The id that will actually be used; `null` when nothing on disk matches. */
  active: string | null
  installed: ReadonlySet<string>
  progress: DownloadProgress | null
  deleting: string | null
  error: string | null
  /** What the footer says about the selection, written by the caller. */
  hint: string
  importLabel: string
  /** Files the catalog does not know, listed without a description or download. */
  extras: readonly string[]
  onPick(id: string): void
  onDownload(id: string): void
  onImport(): void
  onRemove(id: string, label: string): void
}

export function InstallList({
  title,
  entries,
  active,
  installed,
  progress,
  deleting,
  error,
  hint,
  importLabel,
  extras,
  onPick,
  onDownload,
  onImport,
  onRemove
}: InstallListProps) {
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
    <Row stacked title={title}>
      {error && (
        <div className="row-hint err" role="alert">
          {error}
        </div>
      )}
      <div className="models">
        {entries.map((entry) => {
          const ready = installed.has(entry.id)
          const downloading = progress?.model === entry.id && !progress.done
          const share = progress && progress.total > 0 ? progress.received / progress.total : 0
          const name = (
            <>
              <span className="model-name">{entry.label}</span>
              <span className="model-meta">{entry.meta}</span>
            </>
          )
          return (
            <div key={entry.id} className="model-row" data-active={active === entry.id}>
              {ready ? (
                <button className="model-pick" aria-pressed={active === entry.id} onClick={() => onPick(entry.id)}>
                  {name}
                </button>
              ) : (
                <div className="model-pick">{name}</div>
              )}
              {ready ? (
                <div className="model-actions">
                  <span className="model-state ok">Готово</span>
                  {renderDeleteButton(entry.id, entry.label)}
                </div>
              ) : downloading ? (
                <span className="model-state">
                  {progress.received === 0
                    ? 'Подключение…'
                    : progress.total > 0
                      ? `${megabytes(progress.received)} из ${megabytes(progress.total)}`
                      : megabytes(progress.received)}
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
              {downloading && (
                <div className="model-bar">
                  <i style={{ width: `${Math.round(share * 100)}%` }} />
                </div>
              )}
            </div>
          )
        })}
        {extras.map((file) => (
          // An imported file the catalog does not know: no description and no
          // «Скачать», but it can be the one in use, and then it is highlighted
          // like any other row.
          <div key={file} className="model-row" data-active={active === file}>
            <button className="model-pick" aria-pressed={active === file} onClick={() => onPick(file)}>
              <span className="model-name">{file}</span>
            </button>
            {renderDeleteButton(file, file)}
          </div>
        ))}
      </div>
      <div className="row-actions">
        <span className="row-hint">{hint}</span>
        <button
          className="ghost"
          disabled={progress !== null || deleting !== null}
          onClick={onImport}
        >
          {importLabel}
        </button>
      </div>
    </Row>
  )
}
