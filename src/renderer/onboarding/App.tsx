/**
 * First-run onboarding (ТЗ §7.3): permissions, API key, hotkey reminder.
 * Everything is skippable — the overlay explains what is missing when needed.
 */

import { useCallback, useEffect, useState } from 'react'
import type { PermissionState, ProviderId } from '@shared/types'
import { PROVIDERS, providerInfo } from '@shared/defaults'
import type { SettingsBundle } from '@shared/api'
import { prettyHotkey } from '../settings/HotkeyField'

type Step = 0 | 1 | 2

const STEPS = ['Разрешения', 'Ключ API', 'Готово']

export function App() {
  const [step, setStep] = useState<Step>(0)
  const [permissions, setPermissions] = useState<PermissionState>({
    accessibility: false,
    screenRecording: false,
    microphone: false
  })
  const [bundle, setBundle] = useState<SettingsBundle | null>(null)
  const [provider, setProvider] = useState<ProviderId>('openrouter')
  const [keyInput, setKeyInput] = useState('')
  const [status, setStatus] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void window.smartCursor.permissions.status().then(setPermissions)
    void window.smartCursor.settings.load().then((loaded) => {
      setBundle(loaded)
      setProvider(loaded.settings.provider)
    })
  }, [])

  // Permissions can be granted while this window is open; poll gently so the
  // checkmarks update without the user pressing anything.
  useEffect(() => {
    const timer = window.setInterval(() => {
      void window.smartCursor.permissions.status().then(setPermissions)
    }, 1500)
    return () => window.clearInterval(timer)
  }, [])

  const request = useCallback(async () => {
    const next = await window.smartCursor.permissions.request()
    setPermissions(next)
  }, [])

  /** The microphone is asked for on its own: it is optional, the others are not. */
  const requestMicrophone = useCallback(async () => {
    const granted = await window.smartCursor.permissions.requestMicrophone()
    setPermissions((prev) => ({ ...prev, microphone: granted }))
  }, [])

  const saveKey = useCallback(async () => {
    const key = keyInput.trim()
    if (!key) return
    setBusy(true)
    setStatus(null)
    try {
      const test = await window.smartCursor.settings.testKey(
        provider,
        key,
        bundle?.settings.baseUrls?.[provider]
      )
      if (!test.ok) {
        setStatus({ kind: 'err', text: test.message })
        return
      }
      await window.smartCursor.settings.setKey(provider, key)
      await window.smartCursor.settings.save({
        ...(bundle?.settings ?? ({} as never)),
        provider
      })
      setKeyInput('')
      setStatus({ kind: 'ok', text: test.message })
    } catch {
      setStatus({ kind: 'err', text: 'Не удалось сохранить ключ.' })
    } finally {
      setBusy(false)
    }
  }, [bundle, keyInput, provider])

  const finish = useCallback(async () => {
    await window.smartCursor.onboarding.complete()
  }, [])

  const hotkey = bundle?.settings.hotkey ?? 'Alt+Space'
  const configured = bundle?.keys.find((item) => item.provider === provider)?.configured ?? false

  return (
    <div className="wizard">
      <div className="steps">
        {STEPS.map((label, index) => (
          <div key={label} className={`step ${index === step ? 'active' : ''} ${index < step ? 'done' : ''}`}>
            <span className="num">{index < step ? '✓' : index + 1}</span>
            {label}
          </div>
        ))}
      </div>

      {step === 0 && (
        <section className="panel">
          <h1>Разрешения macOS</h1>
          <p className="lead">
            Smart Cursor читает выделенный текст и вставляет ответ в активное приложение. Без этих
            разрешений он работать не сможет.
          </p>

          <div className="perm">
            <div>
              <div className="perm-title">
                Универсальный доступ {permissions.accessibility ? <span className="ok">✓</span> : null}
              </div>
              <div className="hint">Выделение текста и автоматическая вставка (⌘C / ⌘V).</div>
            </div>
            {!permissions.accessibility && (
              <button className="primary" onClick={() => void request()}>
                Открыть запрос
              </button>
            )}
          </div>

          <div className="perm">
            <div>
              <div className="perm-title">
                Запись экрана {permissions.screenRecording ? <span className="ok">✓</span> : null}
              </div>
              <div className="hint">Скриншот активного окна, когда текст не выделен.</div>
            </div>
            {!permissions.screenRecording && (
              <button onClick={() => void request()}>Запросить доступ</button>
            )}
          </div>

          <div className="perm">
            <div>
              <div className="perm-title">
                Микрофон {permissions.microphone ? <span className="ok">✓</span> : null}
              </div>
              <div className="hint">
                Голосовой ввод: удерживайте хоткей или три пальца на трекпаде и говорите.
                Необязательно — без него всё работает с клавиатуры.
              </div>
            </div>
            {!permissions.microphone && (
              <button onClick={() => void requestMicrophone()}>Разрешить</button>
            )}
          </div>

          <div className="hint">
            После выдачи «Универсального доступа» приложение нужно перезапустить — macOS применяет
            разрешение только к новому процессу.
          </div>

          <div className="actions">
            <button className="ghost" onClick={() => setStep(1)}>
              Пропустить
            </button>
            <div className="spacer" />
            <button className="primary" onClick={() => setStep(1)}>
              Дальше
            </button>
          </div>
        </section>
      )}

      {step === 1 && (
        <section className="panel">
          <h1>Ключ API</h1>
          <p className="lead">
            Ключ хранится в связке ключей macOS и отправляется только выбранному провайдеру.
          </p>

          <div className="providers">
            {PROVIDERS.map((item) => (
              <button
                key={item.id}
                className={`provider ${provider === item.id ? 'active' : ''}`}
                onClick={() => setProvider(item.id)}
              >
                <span className="provider-name">{item.label}</span>
                {bundle?.keys.find((key) => key.provider === item.id)?.configured && (
                  <span className="badge">ключ</span>
                )}
              </button>
            ))}
          </div>

          {configured ? (
            <div className="ok">Ключ для {providerInfo(provider)?.label} уже сохранён.</div>
          ) : (
            <div className="key-entry">
              <input
                type="password"
                placeholder="Вставьте ключ"
                value={keyInput}
                onChange={(event) => setKeyInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void saveKey()
                }}
              />
              <button className="primary" disabled={busy || !keyInput.trim()} onClick={() => void saveKey()}>
                {busy ? 'Проверка…' : 'Проверить'}
              </button>
            </div>
          )}

          {status && <div className={`status ${status.kind}`}>{status.text}</div>}

          {providerInfo(provider) && (
            <div className="hint">
              Ключ можно получить на{' '}
              <a href={providerInfo(provider)?.keyUrl} target="_blank" rel="noreferrer">
                {providerInfo(provider)?.keyUrl}
              </a>
            </div>
          )}

          <div className="actions">
            <button className="ghost" onClick={() => setStep(0)}>
              Назад
            </button>
            <div className="spacer" />
            <button className="ghost" onClick={() => setStep(2)}>
              Позже
            </button>
            <button className="primary" onClick={() => setStep(2)}>
              Дальше
            </button>
          </div>
        </section>
      )}

      {step === 2 && (
        <section className="panel">
          <h1>Всё готово</h1>
          <p className="lead">
            Нажмите <kbd>{prettyHotkey(hotkey)}</kbd> в любой момент, чтобы открыть ассистента рядом
            с курсором.
          </p>

          <ul className="tips">
            <li>Есть выделенный текст — ассистент использует его. Нет — смотрит на экран.</li>
            <li>Если проще показать, чем описать, он сам обведёт кнопку или нарисует стрелку.</li>
            <li>Enter отправляет запрос, ⌘Enter вставляет ответ в активное приложение.</li>
            <li>
              Три пальца на трекпаде: касание открывает карточку, удержание записывает голос.
            </li>
            <li>Esc закрывает оверлей, ничего не отправляя.</li>
            <li>Пароли и банковские приложения по умолчанию исключены.</li>
          </ul>

          <div className="actions">
            <button
              className="ghost"
              onClick={() => {
                window.smartCursor.onboarding.openSettings()
              }}
            >
              Настройки
            </button>
            <div className="spacer" />
            <button className="primary" onClick={() => void finish()}>
              Начать работу
            </button>
          </div>
        </section>
      )}
    </div>
  )
}