import { useEffect, useId, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import type { AppSettings, PermissionState, SystemPermissionRequest } from '@shared/types'
import type { AppPickResult, RunningAppInfo, SettingsBundle } from '@shared/api'
import { DEFAULT_EXCLUDED_APP_NAMES } from '@shared/defaults'
import { PermissionRow } from '../PermissionRow'
import { Group, Row, ToggleRow } from '../Row'

interface PrivacySectionProps {
  draft: AppSettings
  patch(changes: Partial<AppSettings>): void
  permissions: PermissionState | null
  apps: RunningAppInfo[]
  setBundle: Dispatch<SetStateAction<SettingsBundle | null>>
  onAddExcluded(picked: AppPickResult | null): void
}

const PRIVACY_VIEWS = [
  { id: 'permissions', label: 'Разрешения' },
  { id: 'data', label: 'Данные на Mac' },
  { id: 'exceptions', label: 'Исключения' }
] as const

/**
 * A human name for a bundle id.
 *
 * A bundle id is the one thing the exclusion list actually stores, and it is
 * unreadable: `me.proton.pass.electron` is not what the app is called anywhere
 * the user has seen it. Running apps know their own name; the rest is looked up
 * in the shared default map, then read off the last segment.
 */
function appName(bundleId: string, apps: RunningAppInfo[]): string {
  const running = apps.find((app) => app.bundleId === bundleId)
  if (running) return running.name
  const known = DEFAULT_EXCLUDED_APP_NAMES[bundleId]
  if (known) return known
  const last = bundleId.split('.').pop() ?? ''
  return last || bundleId
}

/** The first letter in a tile: enough to tell two rows apart without an icon set. */
function monogram(name: string): string {
  return name.trim().charAt(0).toUpperCase() || '?'
}

export function PrivacySection({ draft, patch, permissions, apps, setBundle, onAddExcluded }: PrivacySectionProps) {
  const navId = useId()
  const [view, setView] = useState<(typeof PRIVACY_VIEWS)[number]['id']>('permissions')
  const [appQuery, setAppQuery] = useState('')
  const searchRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    let latest = 0
    const refresh = () => {
      const request = ++latest
      void window.deskhand.permissions
        .status()
        .then((next) => {
          if (request === latest) {
            setBundle((prev) => (prev ? { ...prev, permissions: next } : prev))
          }
        })
        .catch(() => undefined)
    }
    refresh()
    window.addEventListener('focus', refresh)
    return () => {
      latest++
      window.removeEventListener('focus', refresh)
    }
  }, [setBundle])

  async function requestSystemPermission(kind: SystemPermissionRequest): Promise<void> {
    const next = await window.deskhand.permissions.request(kind)
    setBundle((prev) => (prev ? { ...prev, permissions: next } : prev))
  }

  async function pickExcludedApp(): Promise<void> {
    onAddExcluded(await window.deskhand.settings.pickApp())
  }

  function addExcludedApp(bundleId: string): void {
    if (draft.excludedApps.includes(bundleId)) return
    patch({ excludedApps: [...draft.excludedApps, bundleId] })
    // The «Добавить» button disappears with the row it belonged to, so focus has
    // to go somewhere predictable instead of falling back to the window body.
    searchRef.current?.focus()
  }

  const addableApps = apps.filter((app) => !draft.excludedApps.includes(app.bundleId))
  const appQueryTrimmed = appQuery.trim().toLowerCase()
  const matchingApps = appQueryTrimmed
    ? addableApps.filter(
        (app) =>
          app.name.toLowerCase().includes(appQueryTrimmed) || app.bundleId.toLowerCase().includes(appQueryTrimmed)
      )
    : // A running Mac has dozens of processes; eight is a list, forty is a wall.
      addableApps.slice(0, 8)

  return (
    <div className="pane">
      <nav className="segmented settings-subnav" aria-label="Настройки приватности">
        {PRIVACY_VIEWS.map(({ id, label }) => (
          <button
            key={id}
            type="button"
            className={view === id ? 'active' : ''}
            aria-pressed={view === id}
            aria-controls={`${navId}-${id}`}
            onClick={() => setView(id)}
          >
            {label}
          </button>
        ))}
      </nav>

      <div id={`${navId}-permissions`} hidden={view !== 'permissions'}>
        <Group
          footnote={
            permissions && Object.values(permissions).some(Boolean)
              ? 'Чтобы отозвать доступ, выключи Deskhand в открывшемся разделе macOS.'
              : undefined
          }
        >
          <PermissionRow
            title="Универсальный доступ"
            hint="Читать выделенный текст и вставлять ответ; управлять мышью — только если включён режим «Агент»."
            granted={permissions?.accessibility ?? false}
            onRequest={() => requestSystemPermission('accessibility')}
            onOpen={() => window.deskhand.permissions.open('accessibility')}
          />
          <PermissionRow
            title="Запись экрана"
            hint="Снимок экрана, когда текст не выделен. По умолчанию снимается весь экран; окно — когда в кадре есть исключённое приложение."
            granted={permissions?.screenRecording ?? false}
            onRequest={() => requestSystemPermission('screenRecording')}
            onOpen={() => window.deskhand.permissions.open('screenRecording')}
          />
          <PermissionRow
            title="Микрофон"
            hint="Голосовой ввод: удержание клавиши записывает речь."
            granted={permissions?.microphone ?? false}
            onRequest={async () => {
              const granted = await window.deskhand.permissions.requestMicrophone()
              setBundle((prev) =>
                prev ? { ...prev, permissions: { ...prev.permissions, microphone: granted } } : prev
              )
            }}
            onOpen={() => window.deskhand.permissions.open('microphone')}
          />
        </Group>
      </div>

      <div id={`${navId}-data`} hidden={view !== 'data'}>
        <Group>
          <ToggleRow
            title="Помнить предыдущую команду"
            hint="Последняя просьба добавляется к первому запросу в новой карточке. Выключение удаляет её."
            checked={draft.rememberConversation}
            onChange={(rememberConversation) => patch({ rememberConversation })}
          />
          <ToggleRow
            title="Подробные журналы запусков"
            hint={
              'Пишет промпты, заголовки окон и скриншоты в ' +
              '~/Library/Application Support/Deskhand/agent-runs и agent-dialogs. ' +
              'Выключено по умолчанию — включай только для отладки.'
            }
            checked={draft.agent.saveRunTraces}
            onChange={(saveRunTraces) => patch({ agent: { ...draft.agent, saveRunTraces } })}
          />
          <Row
            title="Ключи API"
            hint="Лежат в отдельном файле с доступом только для твоего пользователя и никогда не показываются целиком."
          />
        </Group>
      </div>

      <div id={`${navId}-exceptions`} hidden={view !== 'exceptions'}>
        <Group
          title="Исключённые приложения"
          footnote="В этих приложениях Deskhand не читает текст и не делает скриншоты."
        >
          <Row stacked>
            <div className="excluded-list">
              {draft.excludedApps.map((bundleId) => {
                const name = appName(bundleId, apps)
                return (
                  <div key={bundleId} className="excluded-row" title={bundleId}>
                    <span className="app-tile" aria-hidden="true">
                      {monogram(name)}
                    </span>
                    <span className="excluded-name" title={bundleId}>
                      {name}
                    </span>
                    <button
                      className="ghost"
                      aria-label={`Убрать ${name} из исключений`}
                      title={bundleId}
                      onClick={() =>
                        patch({
                          excludedApps: draft.excludedApps.filter((item) => item !== bundleId)
                        })
                      }
                    >
                      ✕
                    </button>
                  </div>
                )
              })}
              {draft.excludedApps.length === 0 && (
                <div className="row-hint">Список пуст — ассистент видит все приложения.</div>
              )}
            </div>
            <div className="app-picker">
              <input
                ref={searchRef}
                aria-label="Поиск запущенного приложения"
                placeholder="Поиск запущенного приложения"
                value={appQuery}
                onChange={(event) => setAppQuery(event.target.value)}
                spellCheck={false}
              />
              {addableApps.length === 0 ? (
                <div className="row-hint">Все запущенные приложения уже в исключениях.</div>
              ) : matchingApps.length === 0 ? (
                <div className="row-hint">Ничего не нашлось — попробуй другое имя.</div>
              ) : (
                <div className="app-picker-list" role="list">
                  {matchingApps.map((app) => (
                    <div key={app.bundleId} className="app-picker-row" role="listitem" title={app.bundleId}>
                      <span className="app-tile" aria-hidden="true">
                        {monogram(app.name)}
                      </span>
                      <span className="app-picker-name">{app.name}</span>
                      <button
                        className="ghost"
                        aria-label={`Добавить ${app.name} в исключения`}
                        onClick={() => addExcludedApp(app.bundleId)}
                      >
                        Добавить
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div className="row-actions">
              <button onClick={() => void pickExcludedApp()}>Выбрать .app…</button>
            </div>
          </Row>
        </Group>
      </div>
    </div>
  )
}
