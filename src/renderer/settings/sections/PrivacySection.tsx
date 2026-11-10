/**
 * The «Приватность» tab: the three permission rows, excluded apps, encryption.
 *
 * `setBundle` is passed through as it is rather than wrapped in three separate
 * callbacks: every handler here writes a fresh `permissions` object into the
 * bundle, and the bundle is the "saved" side of the auto-apply comparison — the
 * footer would otherwise announce a pending write for a value already on disk.
 *
 * The permission cards come first because they are the only rows in this window
 * whose fix lives outside it: everything else here can be changed in place.
 */

import type { Dispatch, SetStateAction } from 'react'
import type { AppSettings, PermissionState } from '@shared/types'
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

export function PrivacySection({
  draft,
  patch,
  permissions,
  encryptionAvailable,
  apps,
  setBundle,
  onAddExcluded
}: PrivacySectionProps) {
  /**
   * Asks macOS for both grants at once.
   *
   * The main process has one call for the pair (it prompts for Accessibility and
   * Screen Recording together), so both rows use it. Pressing either row's
   * «Разрешить» therefore shows both prompts — the rows differ in what they
   * explain, not in what they trigger.
   */
  async function requestSystemPermissions(): Promise<void> {
    const next = await window.deskhand.permissions.request()
    setBundle((prev) => (prev ? { ...prev, permissions: next } : prev))
  }

  return (
    <div className="pane">
      <Group title="Доступ">
        <PermissionRow
          title="Универсальный доступ"
          hint="Читать выделенный текст и вставлять ответ; управлять мышью — только если включён режим «Агент»."
          granted={permissions?.accessibility ?? false}
          onRequest={requestSystemPermissions}
          onOpen={() => window.deskhand.permissions.open('accessibility')}
        />
        <PermissionRow
          title="Запись экрана"
          hint="Скриншот активного окна."
          granted={permissions?.screenRecording ?? false}
          onRequest={requestSystemPermissions}
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

      {!encryptionAvailable && (
        <div className="notice err">
          Шифрование Keychain недоступно — ключи API не будут сохранены.
        </div>
      )}

      <Group title="Что запоминается">
        <ToggleRow
          title="Помнить предыдущую команду"
          hint="Последняя просьба добавляется к первому запросу в новой карточке. Выключение удаляет её."
          checked={draft.rememberConversation}
          onChange={(rememberConversation) => patch({ rememberConversation })}
        />
      </Group>

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
            <button
              onClick={async () => {
                const picked = await window.deskhand.settings.pickApp()
                onAddExcluded(picked)
              }}
            >
              Выбрать .app…
            </button>
          </div>
        </Row>
      </Group>
    </div>
  )
}
