/**
 * First-run onboarding (ТЗ §7.3): permissions, API key, hotkey reminder.
 * Everything is skippable — the overlay explains what is missing when needed.
 */

import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { PermissionState, ProviderId } from '@shared/types'
import { PROVIDERS, normalizeBaseUrl, providerInfo } from '@shared/defaults'
import type { SettingsBundle } from '@shared/api'
import { prettyAccelerator } from '@shared/accelerator'
import { WindowBrand } from '../styles/WindowBrand'
import { saveConnection } from './connection'

type Step = 0 | 1 | 2

const STEPS = ['Разрешения', 'Подключение', 'Готово']

/** How often the permission state is re-read while this window is open. */
const PERMISSION_POLL_MS = 1500

/** One macOS permission: what it is for, and the one way to ask for it. */
function PermissionItem({
  title,
  hint,
  granted,
  actionLabel,
  primary = false,
  onRequest
}: {
  title: string
  hint: ReactNode
  granted: boolean
  actionLabel: string
  /** The grant without which the assistant cannot work at all. */
  primary?: boolean
  onRequest(): void
}) {
  return (
    <div className="perm">
      <div>
        <div className="perm-title">
          {title} {granted ? <span className="ok">✓</span> : null}
        </div>
        <div className="hint">{hint}</div>
      </div>
      {!granted && (
        <button className={primary ? 'primary' : undefined} onClick={onRequest}>
          {actionLabel}
        </button>
      )}
    </div>
  )
}

export function App() {
  const [step, setStep] = useState<Step>(0)
  const [permissions, setPermissions] = useState<PermissionState>({
    accessibility: false,
    screenRecording: false,
    microphone: false
  })
  const [bundle, setBundle] = useState<SettingsBundle | null>(null)
  const [provider, setProvider] = useState<ProviderId>('openai')
  const [keyInput, setKeyInput] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [model, setModel] = useState('')
  const [notice, setNotice] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void window.deskhand.permissions.status().then(setPermissions)
    void window.deskhand.settings.load().then((loaded) => {
      setBundle(loaded)
      setProvider(loaded.settings.provider)
      setBaseUrl(loaded.settings.baseUrls?.[loaded.settings.provider] ?? '')
      setModel(loaded.settings.models?.[loaded.settings.provider] ?? '')
    })
  }, [])

  // Permissions can be granted while this window is open; poll gently so the
  // checkmarks update without the user pressing anything.
  useEffect(() => {
    const timer = window.setInterval(() => {
      void window.deskhand.permissions.status().then(setPermissions)
    }, PERMISSION_POLL_MS)
    return () => window.clearInterval(timer)
  }, [])

  const requestPermissions = useCallback(async () => {
    const next = await window.deskhand.permissions.request()
    setPermissions(next)
  }, [])

  /** The microphone is asked for on its own: it is optional, the others are not. */
  const requestMicrophone = useCallback(async () => {
    const granted = await window.deskhand.permissions.requestMicrophone()
    setPermissions((prev) => ({ ...prev, microphone: granted }))
  }, [])

  const saveKey = useCallback(async () => {
    const key = keyInput.trim()
    const root = normalizeBaseUrl(baseUrl)
    if (!key || (baseUrl.trim() !== '' && root === '')) return
    setBusy(true)
    setNotice(null)
    try {
      const test = await window.deskhand.settings.testKey(provider, key, root)
      if (!test.ok) {
        setNotice({ kind: 'err', text: test.message })
        return
      }
      // The store answers with the bundle it now holds: that is what the panel
      // shows, and what the next provider's save builds on.
      const saved = await saveConnection(window.deskhand.settings, {
        provider,
        key,
        model,
        baseUrl: root
      })
      setBundle(saved)
      setKeyInput('')
      setNotice({ kind: 'ok', text: test.message })
    } catch {
      setNotice({ kind: 'err', text: 'Не удалось сохранить ключ.' })
    } finally {
      setBusy(false)
    }
  }, [baseUrl, keyInput, model, provider])

  const completeOnboarding = useCallback(async () => {
    await window.deskhand.onboarding.complete()
  }, [])

  const hotkey = bundle?.settings.hotkey ?? 'Alt+Space'
  const configured = bundle?.keys.find((item) => item.provider === provider)?.configured ?? false
  const baseUrlInvalid = baseUrl.trim() !== '' && normalizeBaseUrl(baseUrl) === ''
  const defaultBaseUrl = providerInfo(provider)?.defaultBaseUrl

  return (
    <div className="wizard">
      <aside className="wizard-rail">
        <WindowBrand subtitle="Первый запуск" />
        <ol className="steps" aria-label="Этапы настройки">
          {STEPS.map((label, index) => (
            <li key={label} className="step" aria-current={index === step ? 'step' : undefined}>
              <span className="num" data-done={index < step} aria-hidden="true">
                {index < step ? '✓' : index + 1}
              </span>
              {label}
            </li>
          ))}
        </ol>
      </aside>

      {step === 0 && (
        <section className="panel">
          <h1>Разрешения macOS</h1>
          <p className="lead">
            Deskhand читает выделенный текст и вставляет ответ в активное приложение. Без этих
            разрешений он работать не сможет.
          </p>

          <div className="permission-list">
            <PermissionItem
              title="Универсальный доступ"
              hint="Выделение текста и автоматическая вставка (⌘C / ⌘V)."
              granted={permissions.accessibility}
              actionLabel="Открыть запрос"
              primary
              onRequest={() => void requestPermissions()}
            />

            <PermissionItem
              title="Запись экрана"
              hint="Скриншот активного окна, когда текст не выделен."
              granted={permissions.screenRecording}
              actionLabel="Запросить доступ"
              onRequest={() => void requestPermissions()}
            />

            <PermissionItem
              title="Микрофон"
              hint="Голосовой ввод: удерживай хоткей или три пальца на трекпаде и говори. Необязательно — без него всё работает с клавиатуры."
              granted={permissions.microphone}
              actionLabel="Разрешить"
              onRequest={() => void requestMicrophone()}
            />
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
          <h1>Подключение</h1>
          <p className="lead">
            Модель, ключ и адрес API. Ключ хранится в связке ключей macOS и отправляется только
            выбранному провайдеру.
          </p>

          <div className="providers">
            {PROVIDERS.map((item) => (
              <button
                key={item.id}
                className="provider"
                aria-pressed={provider === item.id}
                onClick={() => {
                  setProvider(item.id)
                  setBaseUrl(bundle?.settings.baseUrls?.[item.id] ?? '')
                  setModel(bundle?.settings.models?.[item.id] ?? '')
                }}
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
            <>
              <div className="field">
                <input
                  value={model}
                  onChange={(event) => setModel(event.target.value)}
                  aria-label="Модель"
                  spellCheck={false}
                />
                <div className="hint">
                  ID модели {providerInfo(provider)?.label}. Его задаёшь ты — встроенного значения нет.
                </div>
              </div>

              <div className="key-entry">
                <input
                  type="password"
                  placeholder="Вставь ключ"
                  value={keyInput}
                  onChange={(event) => setKeyInput(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') void saveKey()
                  }}
                />
                <button
                  className="primary"
                  disabled={busy || !keyInput.trim() || baseUrlInvalid}
                  onClick={() => void saveKey()}
                >
                  {busy ? 'Проверка…' : 'Проверить'}
                </button>
              </div>

              <div className="field">
                <input
                  value={baseUrl}
                  onChange={(event) => setBaseUrl(event.target.value)}
                  placeholder={defaultBaseUrl}
                  aria-label="Base URL"
                  spellCheck={false}
                />
                <div className={`hint${baseUrlInvalid ? ' err' : ''}`}>
                  {baseUrlInvalid
                    ? 'Некорректный адрес: нужен http(s)-адрес вида https://host/v1.'
                    : `Корень API без /chat/completions. Пусто — ${defaultBaseUrl}.`}
                </div>
              </div>
            </>
          )}

          {notice && <div className={`status ${notice.kind}`}>{notice.text}</div>}

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
            Нажми <kbd>{prettyAccelerator(hotkey)}</kbd> в любой момент, чтобы открыть ассистента рядом
            с курсором.
          </p>

          <ul className="tips">
            <li>Есть выделенный текст — ассистент использует его. Нет — смотрит на экран.</li>
            <li>Если проще показать, чем описать, он сам обведёт кнопку или нарисует стрелку.</li>
            <li>Enter отправляет запрос, а готовый ответ можно скопировать кнопкой под ним.</li>
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
                window.deskhand.onboarding.openSettings()
              }}
            >
              Настройки
            </button>
            <div className="spacer" />
            <button className="primary" onClick={() => void completeOnboarding()}>
              Начать работу
            </button>
          </div>
        </section>
      )}
    </div>
  )
}