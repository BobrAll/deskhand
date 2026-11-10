/**
 * The «Агент» settings tab.
 *
 * This section is not a list of preferences, it is a permission form. Everything
 * on it answers one question the user is right to ask before turning it on:
 * "what exactly is it allowed to do to my machine, and how do I stop it?"
 *
 * Two cards, in that order: what it may do (the switch and the grant it needs),
 * then the limits that keep a misunderstood request from running all afternoon.
 * There is deliberately no list of per-action permissions here: the actions that
 * need one are asked about at the moment they happen, in the card, next to the
 * element they concern — a switch in a settings window is a worse place to
 * decide whether to send a message than the message itself.
 */

import { useCallback, useEffect, useState } from 'react'
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

export function AgentTab({ agent, onChange, onEnabledChange }: AgentTabProps) {
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
      <Group title="Управление">
        <ToggleRow
          title="Разрешить управлять мышью и клавиатурой"
          hint="Сохраняется сразу. Пока выключено, ассистент отвечает словами и рисует, но ничего не нажимает."
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
            {state === 'blocked' && (availability?.reason ?? 'Нужен доступ в «Универсальный доступ».')}
          </span>
          {state === 'blocked' && (
            <button
              onClick={() => window.deskhand.permissions.open('accessibility')}
            >
              Открыть доступ
            </button>
          )}
        </div>

        <Row
          title="Постоянные разрешения"
          hint={
            approvalStatus ||
            'Выбор «Разрешить всегда» запоминается для каждого действия отдельно.'
          }
        >
          <button
            type="button"
            onClick={() => {
              void window.deskhand.agent.clearApprovals().then(
                () => setApprovalStatus('Разрешено заново спрашивать обо всём.'),
                () => setApprovalStatus('Не удалось сбросить разрешения.')
              )
            }}
          >
            Забыть
          </button>
        </Row>
      </Group>

      <Group
        title="На экране"
        footnote="Только показ: действия идут через те же API macOS, скорость не меняется."
      >
        <ToggleRow
          title="Показывать действия"
          hint="Нужное окно выходит вперёд, и по экрану ходит курсор агента. Выключи, если он не должен забирать экран."
          checked={agent.showActions}
          onChange={(showActions) => onChange({ showActions })}
        />
      </Group>

      <Group
        title="Границы"
        footnote="Escape останавливает задачу в любой момент, независимо от этих настроек."
      >
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

        <ToggleRow
          title="Останавливать, если я взял мышь"
          hint="Потянулся за курсором — управление сразу вернулось к тебе."
          checked={agent.abortOnMouseMove}
          onChange={(abortOnMouseMove) => onChange({ abortOnMouseMove })}
        />

        <ToggleRow
          title="Проверять результат по экрану"
          hint="После действия агент проверяет, что на экране действительно изменилось."
          checked={agent.verifyResult}
          onChange={(verifyResult) => onChange({ verifyResult })}
        />
      </Group>
    </div>
  )
}
