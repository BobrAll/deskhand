/**
 * First-run onboarding (ТЗ §7.3): permissions, API key, hotkey reminder.
 * Everything is skippable — the overlay explains what is missing when needed.
 */

import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { PermissionState, ProviderId, SystemPermissionRequest } from '@shared/types'
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

/**
 * What the last screen may claim.
 *
 * The wizard is skippable, so "Готово" is only true when the key, the model and
 * the one permission the assistant cannot work without are all in place.
 */
function finishState(bundle: SettingsBundle | null, permissions: PermissionState) {
  if (!bundle) {
    return { heading: 'Готово', hint: 'Проверь настройки, если что-то не работает.' }
  }
  const provider = bundle.settings.provider
  const label = providerInfo(provider)?.label ?? provider
  const configured = bundle.keys.some((key) => key.provider === provider && key.configured)
  const model = (bundle.settings.models?.[provider] ?? '').trim()

  if (!configured) {
    return {
      heading: 'Осталось добавить ключ',
      hint: `Вернись на шаг «Подключение» и сохрани ключ для ${label}. Без ключа ассистент не ответит.`
    }
  }
  if (!model) {
    return {
      heading: 'Осталось выбрать модель',
      hint: `Ключ для ${label} сохранён. Открой шаг «Подключение» и выбери модель.`
    }
  }
  if (!permissions.accessibility) {
    return {
      heading: 'Разреши доступ и перезапусти',
      hint: 'Без «Универсального доступа» ассистент не прочитает выделение. Выдай разрешение и перезапусти Deskhand.'
    }
  }
  return { heading: 'Готово', hint: 'Разрешения выданы, ключ и модель на месте. Можно пробовать.' }
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
  const [models, setModels] = useState<string[] | null>(null)
  const [modelQuery, setModelQuery] = useState('')
  const [modelsError, setModelsError] = useState<string | null>(null)
  const [loadingModels, setLoadingModels] = useState(false)
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

  /** Each button asks for exactly the permission it names. */
  const requestPermission = useCallback(async (kind: SystemPermissionRequest) => {
    const next = await window.deskhand.permissions.request(kind)
    setPermissions(next)
  }, [])

  /** The microphone is asked for on its own: it is optional, the others are not. */
  const requestMicrophone = useCallback(async () => {
    const granted = await window.deskhand.permissions.requestMicrophone()
    setPermissions((prev) => ({ ...prev, microphone: granted }))
  }, [])

  /**
   * Writes the current draft without touching the key.
   *
   * The model is chosen after the key is saved, so this path must not call
   * `setKey` again — and it must not be lost when the window closes.
   */
  const persist = useCallback(
    async (patch: { model?: string; baseUrl?: string }) => {
      if (!bundle) return
      const settings = {
        ...bundle.settings,
        provider,
        models: { ...(bundle.settings.models ?? {}), [provider]: (patch.model ?? model).trim() },
        baseUrls: { ...(bundle.settings.baseUrls ?? {}), [provider]: patch.baseUrl ?? normalizeBaseUrl(baseUrl) }
      }
      try {
        setBundle(await window.deskhand.settings.save(settings))
      } catch {
        setNotice({ kind: 'err', text: 'Не удалось сохранить настройки.' })
      }
    },
    [baseUrl, bundle, model, provider]
  )

  const loadModels = useCallback(
    async (root: string) => {
      setLoadingModels(true)
      setModelsError(null)
      try {
        const result = await window.deskhand.settings.listModels(provider, root)
        if (result.ok) {
          setModels(result.models)
          setModelQuery('')
          setNotice({ kind: 'ok', text: `Моделей: ${result.models.length}. Выбери нужную.` })
        } else {
          setModels(null)
          setModelsError(result.message)
        }
      } catch {
        setModels(null)
        setModelsError('Не удалось загрузить список моделей.')
      } finally {
        setLoadingModels(false)
      }
    },
    [provider]
  )

  /**
   * Checks the key, saves it, then asks the provider for its catalogue.
   *
   * The catalogue request needs the key in the store, so the order is fixed:
   * test → save → list.
   */
  const checkKey = useCallback(async () => {
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
      await loadModels(root)
    } catch {
      setNotice({ kind: 'err', text: 'Не удалось сохранить ключ.' })
    } finally {
      setBusy(false)
    }
  }, [baseUrl, keyInput, loadModels, model, provider])

  const completeOnboarding = useCallback(async () => {
    await window.deskhand.onboarding.complete()
  }, [])

  const hotkey = bundle?.settings.hotkey ?? 'Alt+Space'
  const voiceHotkey = bundle?.settings.voice.hotkey ?? 'Control+Alt'
  const dictationHotkey = bundle?.settings.voice.dictationHotkey ?? 'Fn+Control'
  const configured = bundle?.keys.find((item) => item.provider === provider)?.configured ?? false
  const baseUrlInvalid = baseUrl.trim() !== '' && normalizeBaseUrl(baseUrl) === ''
  const defaultBaseUrl = providerInfo(provider)?.defaultBaseUrl
  const providerLabel = providerInfo(provider)?.label ?? provider
  const finish = finishState(bundle, permissions)

  const query = modelQuery.trim().toLowerCase()
  const visibleModels = models ? models.filter((item) => item.toLowerCase().includes(query)) : []
  // The chosen value must stay selected even when the search hides it.
  if (models && model && !visibleModels.includes(model)) visibleModels.unshift(model)

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
            Deskhand читает выделенный текст и вставляет ответ в активное приложение. Без этих разрешений он работать не
            сможет.
          </p>

          <div className="permission-list">
            <PermissionItem
              title="Универсальный доступ"
              hint="Выделение текста и автоматическая вставка (⌘C / ⌘V)."
              granted={permissions.accessibility}
              actionLabel="Открыть запрос"
              primary
              onRequest={() => void requestPermission('accessibility')}
            />

            <PermissionItem
              title="Запись экрана"
              hint="Снимок экрана, когда текст не выделен. По умолчанию снимается весь экран; окно — когда в кадре есть исключённое приложение."
              granted={permissions.screenRecording}
              actionLabel="Запросить доступ"
              onRequest={() => void requestPermission('screenRecording')}
            />

            <PermissionItem
              title="Микрофон"
              hint="Голосовой ввод: удерживай хоткей и говори. Необязательно — без него всё работает с клавиатуры."
              granted={permissions.microphone}
              actionLabel="Разрешить"
              onRequest={() => void requestMicrophone()}
            />
          </div>

          <div className="hint">
            После выдачи «Универсального доступа» приложение нужно перезапустить — macOS применяет разрешение только к
            новому процессу.
          </div>

          <div className="actions">
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
            {configured
              ? `Ключ для ${providerLabel} уже сохранён. Выбери модель или загрузи список.`
              : 'Модель, ключ и адрес API. Ключ хранится в связке ключей macOS и отправляется только выбранному провайдеру.'}
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
                  setModels(null)
                  setModelsError(null)
                  setModelQuery('')
                  setNotice(null)
                }}
              >
                <span className="provider-name">{item.label}</span>
                {bundle?.keys.find((key) => key.provider === item.id)?.configured && (
                  <span className="badge">ключ</span>
                )}
              </button>
            ))}
          </div>

          {!configured && (
            <div className="key-entry">
              <input
                type="password"
                placeholder="Вставь ключ"
                value={keyInput}
                onChange={(event) => setKeyInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void checkKey()
                }}
              />
              <button
                className="primary"
                disabled={busy || !keyInput.trim() || baseUrlInvalid}
                onClick={() => void checkKey()}
              >
                {busy ? 'Проверяю…' : 'Проверить и загрузить модели'}
              </button>
            </div>
          )}

          {notice && <div className={`status ${notice.kind}`}>{notice.text}</div>}

          <div className="field">
            <div className="model-head">
              <span className="field-label">Модель</span>
              {models === null && configured && (
                <button
                  className="link"
                  disabled={loadingModels || baseUrlInvalid}
                  onClick={() => void loadModels(normalizeBaseUrl(baseUrl))}
                >
                  {loadingModels ? 'Загружаю…' : 'Загрузить модели'}
                </button>
              )}
            </div>

            {models === null ? (
              <>
                <input
                  value={model}
                  onChange={(event) => setModel(event.target.value)}
                  onBlur={() => void persist({ model })}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') void persist({ model })
                  }}
                  aria-label="Модель"
                  placeholder="Например, gpt-4.1-mini"
                  spellCheck={false}
                />
                <div className={`hint${modelsError ? ' err' : ''}`}>
                  {modelsError ?? `ID модели ${providerLabel}. Его задаёшь ты — встроенного значения нет.`}
                </div>
              </>
            ) : (
              <>
                <input
                  className="search"
                  value={modelQuery}
                  onChange={(event) => setModelQuery(event.target.value)}
                  placeholder={`Найти модель ${providerLabel}`}
                  aria-label="Поиск модели"
                  spellCheck={false}
                />
                <select
                  value={model}
                  aria-label="Выбор модели"
                  onChange={(event) => {
                    setModel(event.target.value)
                    void persist({ model: event.target.value })
                  }}
                >
                  <option value="">Выбери модель</option>
                  {visibleModels.map((item) => (
                    <option key={item} value={item}>
                      {item}
                    </option>
                  ))}
                </select>
                <input
                  value={model}
                  onChange={(event) => setModel(event.target.value)}
                  onBlur={() => void persist({ model })}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') void persist({ model })
                  }}
                  aria-label="ID модели вручную"
                  placeholder="Или впиши ID вручную"
                  spellCheck={false}
                />
                <div className="hint">
                  {visibleModels.length === 0
                    ? 'Ничего не нашлось. Проверь запрос или впиши ID вручную.'
                    : 'Выбери модель из списка или впиши ID вручную.'}
                </div>
              </>
            )}
          </div>

          {providerInfo(provider) && (
            <div className="hint">
              Ключ можно получить на{' '}
              <a href={providerInfo(provider)?.keyUrl} target="_blank" rel="noreferrer">
                {providerInfo(provider)?.keyUrl}
              </a>
            </div>
          )}

          <details className="disclosure">
            <summary>Base URL</summary>
            <div className="field">
              <input
                value={baseUrl}
                onChange={(event) => setBaseUrl(event.target.value)}
                onBlur={() => {
                  if (!baseUrlInvalid) void persist({ baseUrl: normalizeBaseUrl(baseUrl) })
                }}
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
          </details>

          <div className="actions">
            <button className="ghost" onClick={() => setStep(0)}>
              Назад
            </button>
            <div className="spacer" />
            <button className="primary" onClick={() => setStep(2)}>
              {configured ? 'Продолжить' : 'Продолжить без ключа'}
            </button>
          </div>
        </section>
      )}

      {step === 2 && (
        <section className="panel">
          <h1>{finish.heading}</h1>
          <p className="lead">{finish.hint}</p>

          <ul className="tips">
            <li>
              <kbd>{prettyAccelerator(hotkey)}</kbd> открывает карточку рядом с курсором. Удерживай{' '}
              <kbd>{prettyAccelerator(voiceHotkey)}</kbd> для голоса, <kbd>{prettyAccelerator(dictationHotkey)}</kbd> —
              чтобы надиктовать в поле.
            </li>
            <li>Есть выделенный текст — ассистент использует его. Нет — смотрит на экран.</li>
            <li>Если проще показать, чем описать, он сам обведёт кнопку или нарисует стрелку.</li>
            <li>Enter отправляет запрос, а готовый ответ можно скопировать кнопкой под ним.</li>
            <li>Esc закрывает оверлей, ничего не отправляя.</li>
            <li>Пароли и менеджеры паролей по умолчанию исключены.</li>
          </ul>

          <div className="hint">«Попробовать сейчас» закроет окно и покажет карточку рядом с курсором.</div>

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
            <button className="ghost" onClick={() => void completeOnboarding()}>
              Начать работу
            </button>
            <button
              className="primary"
              onClick={() => {
                window.deskhand.onboarding.tryIt()
              }}
            >
              Попробовать сейчас
            </button>
          </div>
        </section>
      )}
    </div>
  )
}
