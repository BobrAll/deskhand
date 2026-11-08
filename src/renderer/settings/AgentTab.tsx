/**
 * The «Агент» settings tab.
 *
 * This section is not a list of preferences, it is a permission form. Everything
 * on it answers one question the user is right to ask before turning it on:
 * "what exactly is it allowed to do to my machine, and how do I stop it?"
 *
 * So the layout is: the switch, then the gates macOS puts in front of it (each
 * with its own fix), then the one limit that matters, then the escape hatches.
 * There is deliberately no list of per-action permissions here: the actions that
 * need one are asked about at the moment they happen, in the card, next to the
 * element they concern — a checkbox in a settings window is a worse place to
 * decide whether to send a message than the message itself.
 */

import { useCallback, useEffect, useState } from 'react'
import type { AgentAvailability, AgentSettings } from '@shared/types'

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

export function AgentTab({ agent, onChange, onEnabledChange }: AgentTabProps) {
  const [approvalStatus, setApprovalStatus] = useState('')
  const [availability, setAvailability] = useState<AgentAvailability | null>(null)
  const [steps, setSteps] = useState(String(agent.maxSteps))

  const refresh = useCallback(() => {
    void window.smartCursor.agent
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

  // The draft is only persisted on save, so the panel would otherwise keep showing
  // the old answer until the window was reopened.
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

  return (
    <section>
      <h2>Агент</h2>

      <div className="field">
        <label className="check">
          <input
            type="checkbox"
            checked={agent.enabled}
            onChange={(event) => {
              const enabled = event.target.checked
              // This one is written straight through instead of waiting for the
              // panel's autosave: it decides whether the assistant can act at all,
              // and a tick that has not reached the disk yet looks exactly like a
              // broken mode the next time something is asked of it.
              onChange({ enabled })
              void onEnabledChange(enabled)
                .then(setAvailability)
                .catch(() => undefined)
            }}
          />{' '}
          Разрешить управлять мышью и клавиатурой
        </label>
        <div className="hint">
          Сохраняется сразу. Пока выключено, ассистент отвечает словами и рисует, но ничего
          не нажимает.
        </div>
      </div>

      {agent.enabled && availability && !availability.ready && (
        <div className="field">
          <label>Готовность</label>
          <div className="agent-ready">
            <span className="agent-ready-dot" aria-hidden />
            <span>{availability.reason ?? 'Нужен доступ в «Универсальный доступ».'}</span>
            <button
              className="tag"
              onClick={() => window.smartCursor.permissions.open('accessibility')}
            >
              Открыть доступ
            </button>
          </div>
        </div>
      )}

      <div className="field">
        <label htmlFor="agent-max-steps">Лимит шагов задачи</label>
        <input
          id="agent-max-steps"
          type="number"
          min={1}
          step={1}
          value={steps}
          onChange={(event) => editSteps(event.target.value)}
          onBlur={() => setSteps(String(agent.maxSteps))}
        />
        <div className="hint">
          Сколько действий агент может сделать за одну задачу. Escape останавливает в любой
          момент.
        </div>
      </div>

      <div className="field">
        <label className="check">
          <input
            type="checkbox"
            checked={agent.abortOnMouseMove}
            onChange={(event) => onChange({ abortOnMouseMove: event.target.checked })}
          />{' '}
          Останавливать, если я взял мышь
        </label>
        <div className="hint">
          Потянулись за курсором — управление сразу вернулось к вам.
        </div>
      </div>

      <div className="field">
        <label className="check">
          <input
            type="checkbox"
            checked={agent.verifyResult}
            onChange={(event) => onChange({ verifyResult: event.target.checked })}
          />{' '}
          Проверять результат по экрану
        </label>
        <div className="hint">
          После действия агент проверяет, что на экране действительно изменилось.
        </div>
      </div>

      <div className="field">
        <button
          type="button"
          onClick={() => {
            void window.smartCursor.agent.clearApprovals().then(
              () => setApprovalStatus('Разрешения сброшены.'),
              () => setApprovalStatus('Не удалось сбросить разрешения.')
            )
          }}
        >
          Сбросить постоянные разрешения
        </button>
        <div className="hint" role="status">
          {approvalStatus || 'Забыть выбор «Разрешить всегда» для всех действий.'}
        </div>
      </div>
    </section>
  )
}
