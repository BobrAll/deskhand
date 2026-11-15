import { useEffect, useId, useState, type Dispatch, type SetStateAction } from 'react'
import type { AppSettings, PermissionState, SystemPermissionRequest } from '@shared/types'
import type { AppPickResult, RunningAppInfo, SettingsBundle } from '@shared/api'
import { PermissionRow } from '../PermissionRow'
import { Group, Row, ToggleRow } from '../Row'

interface PrivacySectionProps {
  draft: AppSettings
  patch(changes: Partial<AppSettings>): void
  permissions: PermissionState | null
  encryptionAvailable: boolean
  apps: RunningAppInfo[]
  setBundle: Dispatch<SetStateAction<SettingsBundle | null>>
  onAddExcluded(picked: AppPickResult | null): void
}

const PRIVACY_VIEWS = [
  { id: 'permissions', label: 'Разрешения' },
  { id: 'data', label: 'Данные на Mac' },
  { id: 'exceptions', label: 'Исключения' }
] as const

export function PrivacySection({
  draft,
  patch,
  permissions,
  encryptionAvailable,
  apps,
  setBundle,
  onAddExcluded
}: PrivacySectionProps) {
  const navId = useId()
  const [view, setView] = useState<(typeof PRIVACY_VIEWS)[number]['id']>('permissions')

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
            hint="Скриншот активного окна."
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
            hint={
              encryptionAvailable
                ? 'Шифрование средствами macOS доступно.'
                : 'Шифрование ключей средствами macOS недоступно.'
            }
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
              {draft.excludedApps.map((bundleId) => (
                <div key={bundleId} className="excluded-row">
                  <span className="mono">{bundleId}</span>
                  <button
                    className="ghost"
                    aria-label={`Убрать ${bundleId} из исключений`}
                    onClick={() =>
                      patch({
                        excludedApps: draft.excludedApps.filter((item) => item !== bundleId)
                      })
                    }
                  >
                    ✕
                  </button>
                </div>
              ))}
              {draft.excludedApps.length === 0 && (
                <div className="row-hint">Список пуст — ассистент видит все приложения.</div>
              )}
            </div>
            <div className="row-actions">
              <select
                value=""
                aria-label="Добавить запущенное приложение в исключения"
                onChange={(event) => {
                  const bundleId = event.target.value
                  if (bundleId && !draft.excludedApps.includes(bundleId)) {
                    patch({ excludedApps: [...draft.excludedApps, bundleId] })
                  }
                }}
              >
                <option value="">Выбрать из запущенных…</option>
                {apps
                  .filter((app) => !draft.excludedApps.includes(app.bundleId))
                  .map((app) => (
                    <option key={app.bundleId} value={app.bundleId}>
                      {app.name}
                    </option>
                  ))}
              </select>
              <button onClick={() => void pickExcludedApp()}>Выбрать .app…</button>
            </div>
          </Row>
        </Group>
      </div>
    </div>
  )
}
