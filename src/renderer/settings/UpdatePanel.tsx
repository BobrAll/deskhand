/**
 * The sidebar's update block: one line of status and one button.
 *
 * The window renders `UpdateState` exactly as the main process reports it —
 * every step (feed, checksum, signature, swap) happens there, and the buttons
 * only ask. Mounts mid-flow, so the first thing it does is pull the state.
 */

import { useCallback, useEffect, useState } from 'react'
import type { UpdateState } from '@shared/types'

function formatSize(bytes: number | null): string {
  if (bytes === null || !Number.isFinite(bytes) || bytes <= 0) return ''
  return ` — ${Math.round(bytes / (1024 * 1024))} МБ`
}

export function UpdatePanel() {
  const [state, setState] = useState<UpdateState | null>(null)

  useEffect(() => {
    let alive = true
    void window.deskhand.update
      .getState()
      .then((initial) => {
        if (alive) setState(initial)
      })
      .catch(() => undefined)
    const unsubscribe = window.deskhand.update.onState(setState)
    return () => {
      alive = false
      unsubscribe()
    }
  }, [])

  const ask = useCallback((action: () => Promise<void>) => {
    void action().catch(() => undefined)
  }, [])

  if (!state) return null

  const mockNote = state.mock ? ' (демо)' : ''
  const percent = state.progress === null ? null : Math.round(state.progress * 100)

  return (
    <div className="side-update">
      <div className="sidebar-label">Обновление</div>

      {state.phase === 'idle' && (
        <>
          <div className="update-line">
            {state.upToDate ? 'Установлена последняя версия' : `Версия ${state.current}`}
          </div>
          <button onClick={() => ask(() => window.deskhand.update.check())}>Проверить</button>
        </>
      )}

      {state.phase === 'checking' && (
        <>
          <div className="update-line dim">Проверяю…</div>
          <button disabled>Проверить</button>
        </>
      )}

      {state.phase === 'available' && state.latest && (
        <>
          <div className="update-line">
            Доступна версия {state.latest}
            {formatSize(state.sizeBytes)}
            {mockNote}
          </div>
          <button className="primary" onClick={() => ask(() => window.deskhand.update.download())}>
            Обновить
          </button>
        </>
      )}

      {state.phase === 'downloading' && (
        <>
          <div className="update-progress" role="progressbar" aria-valuenow={percent ?? 0}>
            <div style={{ width: `${percent ?? 0}%` }} />
          </div>
          <div className="update-line dim">Скачиваю… {percent === null ? '' : `${percent}%`}</div>
        </>
      )}

      {state.phase === 'ready' && (
        <>
          <div className="update-line">
            Обновление {state.latest ?? ''} скачано{mockNote}
          </div>
          <button className="primary" onClick={() => ask(() => window.deskhand.update.install())}>
            Перезапустить
          </button>
        </>
      )}

      {state.phase === 'error' && (
        <>
          <div className="update-line err">{state.message ?? 'Не удалось обновить.'}</div>
          <button
            onClick={() =>
              ask(
                state.retry === 'download'
                  ? () => window.deskhand.update.download()
                  : () => window.deskhand.update.check()
              )
            }
          >
            Попробовать ещё раз
          </button>
        </>
      )}
    </div>
  )
}
