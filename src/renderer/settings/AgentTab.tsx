import { useCallback, useEffect, useId, useState } from 'react'
import type { AgentAvailability, AgentSettings } from '@shared/types'
import { Group, Row, ToggleRow } from './Row'

interface AgentTabProps {
  agent: AgentSettings
  /** Draft edit for everything on this page, applied by the window's autosave. */
  onChange(changes: Partial<AgentSettings>): void
  /**
   * The master switch, persisted immediately.
   *
   * Separate from `onChange` on purpose: every other value here is a preference
   * that can wait for the save button, but this one decides whether the assistant
   * can act at all. A ticked checkbox sitting in an unsaved draft looks exactly
   * like a broken mode — the user has said yes and still gets a drawing back.
   */
  onEnabledChange(enabled: boolean): Promise<AgentAvailability>
}

const AGENT_VIEWS = [
  { id: 'screen', label: 'На экране' },
  { id: 'limits', label: 'Границы задачи' },
  { id: 'permissions', label: 'Разрешения' }
] as const

export function AgentTab({ agent, onChange, onEnabledChange }: AgentTabProps) {
  const navId = useId()
  const [view, setView] = useState<(typeof AGENT_VIEWS)[number]['id']>('screen')
  const [approvalStatus, setApprovalStatus] = useState('')
  const [availability, setAvailability] = useState<AgentAvailability | null>(null)
  const [steps, setSteps] = useState(String(agent.maxSteps))

  const refresh = useCallback(() => {
    void window.deskhand.agent
      .availability()
      .then(setAvailability)
      .catch(() => setAvailability(null))
  }, [])

  // The grant is given in System Settings, outside the app: nothing announces it,
  // so the state is re-read whenever the window regains focus — that is the
  // moment the user comes back from granting it.
  useEffect(() => {
    refresh()
    const onFocus = (): void => refresh()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [refresh])

  // The master switch is written through its own channel rather than the
  // autosave, so the availability has to be re-read when it changes: the panel
  // would otherwise keep showing the old answer until the window was reopened.
  useEffect(() => {
    refresh()
  }, [agent.enabled, refresh])

  // The input is a text field, not a slider: the user types the budget they want.
  // Keeping the raw string locally lets the field be emptied mid-edit; the value
  // is only committed when it is a positive whole number. The sync from props is
  // skipped when the field already means the same number, so "05" is not rewritten
  // to "5" under the cursor as the user types.
  useEffect(() => {
    setSteps((current) =>
      Number(current) === agent.maxSteps ? current : String(agent.maxSteps)
    )
  }, [agent.maxSteps])

  const editSteps = (raw: string): void => {
    setSteps(raw)
    const value = Math.round(Number(raw))
    if (Number.isFinite(value) && value >= 1) onChange({ maxSteps: value })
  }

  // Three states, and all three are shown. Before, the panel said nothing unless
  // the mode was on but blocked, so "off" and "on and working" looked exactly the
  // same — and the only thing on screen that said anything about access was the
  // privacy tab's OS permission, which is a different question.
  const state = !agent.enabled ? 'off' : availability?.ready ? 'ready' : 'blocked'

  return (
    <div className="pane">
      <Group>
        <ToggleRow
          title="Управлять мышью и клавиатурой"
          checked={agent.enabled}
          onChange={(enabled) => {
            // This one is written straight through instead of waiting for the
            // panel's autosave: it decides whether the assistant can act at all,
            // and a tick that has not reached the disk yet looks exactly like a
            // broken mode the next time something is asked of it.
            onChange({ enabled })
            void onEnabledChange(enabled)
              .then(setAvailability)
              .catch(() => undefined)
          }}
        />

        <div className="agent-ready" data-tone={state}>
          <span className="agent-ready-dot" aria-hidden />
          <span>
            {state === 'off' && 'Режим выключен — ассистент отвечает текстом и рисует.'}
            {state === 'ready' && 'Права выданы, режим включён.'}
            {state === 'blocked' && (availability?.reason ?? 'Готовность агента пока неизвестна.')}
          </span>
          {state === 'blocked' && availability?.needsAccessibility && (
            <button
              onClick={() => window.deskhand.permissions.open('accessibility')}
            >
              Открыть доступ
            </button>
          )}
        </div>
      </Group>

      <nav className="segmented settings-subnav" aria-label="Настройки агента">
        {AGENT_VIEWS.map(({ id, label }) => (
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

      <div id={`${navId}-screen`} hidden={view !== 'screen'}>
        <Group>
          <ToggleRow
            title="Показывать действия"
            hint="Deskhand выводит нужное окно вперёд и показывает курсор агента."
            checked={agent.showActions}
            onChange={(showActions) => onChange({ showActions })}
          />
        </Group>
      </div>

      <div id={`${navId}-limits`} hidden={view !== 'limits'}>
        <Group>
          <ToggleRow
            title="Останавливать при движении мыши"
            hint="Двинь мышь, чтобы вернуть управление."
            checked={agent.abortOnMouseMove}
            onChange={(abortOnMouseMove) => onChange({ abortOnMouseMove })}
          />

          <ToggleRow
            title="Проверять результат по экрану"
            hint="После действия агент проверяет, что на экране действительно изменилось."
            checked={agent.verifyResult}
            onChange={(verifyResult) => onChange({ verifyResult })}
          />

          <Row
            title="Лимит шагов задачи"
            hint="Сколько действий агент может сделать за одну задачу."
          >
            <input
              type="number"
              min={1}
              step={1}
              value={steps}
              aria-label="Лимит шагов задачи"
              onChange={(event) => editSteps(event.target.value)}
              onBlur={() => setSteps(String(agent.maxSteps))}
            />
          </Row>
        </Group>
      </div>

      <div id={`${navId}-permissions`} hidden={view !== 'permissions'}>
        <Group>
          <Row
            stacked
            title="Запомненные разрешения"
            hint="Сбрось решения «Больше не спрашивать», чтобы агент снова спрашивал перед этими действиями."
          >
            <div className="row-actions">
              <button
                type="button"
                onClick={() => {
                  void window.deskhand.agent.clearApprovals().then(
                    () => setApprovalStatus('Разрешения сброшены.'),
                    () => setApprovalStatus('Не удалось сбросить разрешения.')
                  )
                }}
              >
                Сбросить
              </button>
              <span className="row-hint" role="status">{approvalStatus}</span>
            </div>
          </Row>
        </Group>
      </div>

      <p className="group-foot"><kbd>Esc</kbd> останавливает задачу в любой момент.</p>
    </div>
  )
}
