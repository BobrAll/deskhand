/**
 * The «Агент» settings tab.
 *
 * This section is not a list of preferences, it is a permission form. Everything
 * on it answers one question the user is right to ask before turning it on:
 * "what exactly is it allowed to do to my machine, and how do I stop it?"
 *
 * So the layout is: the switch, then the three gates macOS puts in front of it
 * (each with its own fix), then the limits, then the escape hatches. The limits
 * are sliders rather than text fields because their only job is to be understood
 * at a glance — "0.9 с" means nothing, a slider two thirds along a 0–3 с track
 * means "not instantly".
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

function seconds(ms: number): string {
  if (ms === 0) return 'сразу'
  if (ms < 1000) return `${ms} мс`
  return `${(ms / 1000).toFixed(1).replace('.', ',')} с`
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
          Подтверждение нужно для распознанных критических действий: оплаты, подписки,
          отправки и публикации, удаления, изменения доступа или защиты аккаунта.
          Отмена останавливает план. Пароли и секреты вводятся вручную.
        </div>
      </div>

      <div className="field">
        <label>Пауза перед первым действием · {seconds(agent.startDelayMs)}</label>
        <input
          type="range"
          min={0}
          max={3000}
          step={100}
          value={agent.startDelayMs}
          onChange={(event) => onChange({ startDelayMs: Number(event.target.value) })}
        />
        <div className="hint">
          Время, за которое можно передумать: пока идёт пауза, Escape отменяет всё, и ни один
          клик ещё не случился.
        </div>
      </div>

      <div className="field">
        <label>Пауза между действиями · {seconds(agent.stepDelayMs)}</label>
        <input
          type="range"
          min={0}
          max={2000}
          step={20}
          value={agent.stepDelayMs}
          onChange={(event) => onChange({ stepDelayMs: Number(event.target.value) })}
        />
        <div className="hint">
          Слишком быстро — не уследить и не остановить. Слишком медленно — кажется, что
          зависло.
        </div>
      </div>

      <div className="field">
        <label>Лимит этапов задачи · {agent.maxSteps}</label>
        <input
          type="range"
          min={1}
          max={8}
          step={1}
          value={agent.maxSteps}
          onChange={(event) => onChange({ maxSteps: Number(event.target.value) })}
        />
        <div className="hint">
          После действий ассистент проверяет экран и продолжает к цели. Попытки восстановиться
          после ошибки имеют отдельный лимит. Escape останавливает задачу.
        </div>
      </div>

      <div className="field">
        <label>
          <input
            type="checkbox"
            checked={agent.allowTyping}
            onChange={(event) => onChange({ allowTyping: event.target.checked })}
          />{' '}
          Разрешить печатать текст
        </label>
        <div className="hint">
          Ввод в поле, которое сейчас в фокусе. Выключите, если не хотите, чтобы ассистент
          что-то писал за вас, — клики при этом останутся.
        </div>
      </div>

      <div className="field">
        <label>
          <input
            type="checkbox"
            checked={agent.allowShortcuts}
            onChange={(event) => onChange({ allowShortcuts: event.target.checked })}
          />{' '}
          Разрешить горячие клавиши
        </label>
        <div className="hint">
          ⌘S, ⌘W, ⌘Tab и подобные. Выключено — ассистент нажимает только мышью.
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
          Перед словом «Готово» ассистент делает свежий скриншот и сверяет его с просьбой:
          нажал — ещё не значит получилось. Если по экрану не видно результата, он скажет об
          этом, а не отрапортует об успехе. Стоит одного дополнительного запроса на каждую
          просьбу с действиями; при неудаче — до двух, чтобы успеть исправить.
        </div>
      </div>

      <div className="field">
        <label>
          <input
            type="checkbox"
            checked={agent.semanticActions}
            onChange={(event) => onChange({ semanticActions: event.target.checked })}
          />{' '}
          Нажимать элементы по названию, а не по координатам
        </label>
        <div className="hint">
          Для кнопок и полей с подписью ассистент передаёт действие локальному сервису
          computer-use: тот находит элемент по роли и названию, нажимает его через
          Accessibility и ждёт, пока приложение подтвердит изменение. Курсор не двигается, окно
          не поднимается — можно продолжать печатать в своём. Если сервиса нет или элемент не
          найден, шаг выполняется по координатам, как раньше. Выключите, чтобы вообще не
          запускать сервис.
        </div>
      </div>

      <div className="field">
        <div className="hint">
          Что ассистент не делает никогда: не отправляет формы, не удаляет файлы и не
          подтверждает покупки без прямой просьбы. Каждое действие видно в карточке, а
          кнопка «Стоп» и Escape останавливают выполнение мгновенно.
        </div>
      </div>
    </section>
  )
}
