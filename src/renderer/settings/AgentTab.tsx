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

  return (
    <section>
      <h2>Агент</h2>
      <div className="field">
        <button type="button" onClick={() => {
          void window.smartCursor.agent.clearApprovals().then(
            () => setApprovalStatus('Разрешения сброшены.'),
            () => setApprovalStatus('Не удалось сбросить разрешения.')
          )
        }}>Сбросить постоянные разрешения</button>
        <div className="hint" role="status">{approvalStatus || 'Удаляет выбор «Разрешить всегда» для всех действий агента.'}</div>
      </div>
      <p className="hint">
        Ассистент сможет сам нажимать кнопки и печатать текст — не только рассказывать, где
        они. Он делает это только когда вы прямо просите что-то сделать: «нажми сохранить»,
        «открой вкладку», «впиши адрес».
      </p>

      <div className="field">
        <label>
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
          Переключатель сохраняется сразу. Пока выключено, ассистент отвечает словами и может
          рисовать на экране, но ничего не нажимает — даже если вы просите именно нажать.
        </div>
      </div>

      {agent.enabled && (
        <div className="field">
          <label>Готовность</label>
          <div className="agent-ready" data-ok={availability?.ready ? true : undefined}>
            {availability?.ready ? (
              <>
                <span className="agent-ready-dot" aria-hidden />
                <span>Всё готово: можно нажимать и печатать.</span>
              </>
            ) : (
              <>
                <span className="agent-ready-dot" aria-hidden />
                <span>{availability?.reason ?? 'Проверяю доступ…'}</span>
                <button
                  className="tag"
                  onClick={() => window.smartCursor.permissions.open('accessibility')}
                >
                  Открыть доступ
                </button>
              </>
            )}
          </div>
        </div>
      )}

      <div className="field">
        <label>Подтверждение действий</label>
        <div className="hint">
          Обычные клики, навигация и ввод текста выполняются самостоятельно.
          Подтверждение нужно для того, что нельзя отменить: оплаты, подписки, отправки и
          публикации, удаления, изменения доступа или защиты аккаунта. Вопрос появляется
          прямо в карточке, на том шаге, к которому относится, — с кнопками «Разрешить»,
          «Разрешить всегда» и «Отменить». Пароли и секреты агент не вводит никогда.
        </div>
      </div>

      <div className="field">
        <label>Лимит шагов задачи · {agent.maxSteps}</label>
        <input
          type="range"
          min={1}
          max={50}
          step={1}
          value={agent.maxSteps}
          onChange={(event) => onChange({ maxSteps: Number(event.target.value) })}
        />
        <div className="hint">
          Сколько раз агент может посмотреть на экран и что-то сделать, прежде чем
          остановиться. Это потолок, а не план: одна задача — это обычно осмотреться,
          сделать и проверить, а поиск по интерфейсу, ввод текста и подтверждение
          добавляют ещё по шагу. Ставьте с запасом: упёршись в лимит, агент
          останавливается с невыполненной задачей, а не доводит её до конца.
          Escape останавливает задачу в любой момент.
        </div>
      </div>

      <div className="field">
        <label>
          <input
            type="checkbox"
            checked={agent.abortOnMouseMove}
            onChange={(event) => onChange({ abortOnMouseMove: event.target.checked })}
          />{' '}
          Останавливать, если я взял мышь
        </label>
        <div className="hint">
          Самое надёжное «нет»: потянулись за курсором — управление сразу вернулось к вам.
          Escape работает всегда, независимо от этой настройки.
        </div>
      </div>

      <div className="field">
        <label>
          <input
            type="checkbox"
            checked={agent.verifyResult}
            onChange={(event) => onChange({ verifyResult: event.target.checked })}
          />{' '}
          Проверять результат по экрану
        </label>
        <div className="hint">
          После последнего действия агент заново читает состояние окна и сравнивает его с
          тем, что было до действия: нажал — ещё не значит получилось. Если ничего не
          изменилось, он видит это и пробует иначе, вместо того чтобы сказать «готово».
        </div>
      </div>

      <div className="field">
        <div className="hint">
          Что ассистент не делает никогда: не отправляет формы, не удаляет файлы и не
          подтверждает покупки без вашего ответа. Такие действия он показывает в карточке
          кнопкой «Разрешить» и ждёт. Всё, что он делает, видно в карточке строкой за
          строкой, а Escape и рука на мыши останавливают его мгновенно.
        </div>
      </div>
    </section>
  )
}
