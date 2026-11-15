/**
 * First-run onboarding (ТЗ §7.3): permissions, API key, hotkey reminder.
 * Everything is skippable — the overlay explains what is missing when needed.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { AppSettings, PermissionState, ProviderId, SystemPermissionRequest } from '@shared/types'
import { PROVIDERS, normalizeBaseUrl, providerInfo } from '@shared/defaults'
import type { SettingsBundle } from '@shared/api'
import { prettyAccelerator } from '@shared/accelerator'
import { WindowBrand } from '../styles/WindowBrand'
import { saveConnection } from './connection'
import { finishState } from './finish'

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
 * The model input in either of its two states.
 *
 * Before the catalogue is loaded there is one text field; after it there is a
 * search, a filtered list and the same manual field as the escape hatch. Keeping
 * both states here means the disabled/busy rules and the "keep the chosen value
 * visible" rule cannot drift between them.
 */
function ModelControl({
  providerLabel,
  model,
  models,
  modelsError,
  query,
  busy,
  onQuery,
  onModel,
  onSave
}: {
  providerLabel: string
  model: string
  models: string[] | null
  modelsError: string | null
  query: string
  busy: boolean
  onQuery(value: string): void
  onModel(value: string): void
  onSave(value: string): void
}) {
  const visible = models ? models.filter((item) => item.toLowerCase().includes(query.trim().toLowerCase())) : []
  // A select whose value is missing from its options silently shows the first
  // one; the chosen model stays in the list even when the search hides it.
  if (models && model && !visible.includes(model)) visible.unshift(model)

  const manual = (
    <input
      value={model}
      disabled={busy}
      onChange={(event) => onModel(event.target.value)}
      onBlur={() => onSave(model)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') onSave(model)
      }}
      aria-label={models === null ? 'Модель' : 'ID модели вручную'}
      placeholder={models === null ? 'Например, gpt-4.1-mini' : 'Или впиши ID вручную'}
      spellCheck={false}
    />
  )

  if (models === null) {
    return (
      <>
        {manual}
        <div className={`hint${modelsError ? ' err' : ''}`}>
          {modelsError ?? `ID модели ${providerLabel}. Его задаёшь ты — встроенного значения нет.`}
        </div>
      </>
    )
  }

  return (
    <>
      <input
        className="search"
        value={query}
        onChange={(event) => onQuery(event.target.value)}
        placeholder={`Найти модель ${providerLabel}`}
        aria-label="Поиск модели"
        spellCheck={false}
      />
      <select value={model} aria-label="Выбор модели" disabled={busy} onChange={(event) => onSave(event.target.value)}>
        <option value="">Выбери модель</option>
        {visible.map((item) => (
          <option key={item} value={item}>
            {item}
          </option>
        ))}
      </select>
      {manual}
      <div className="hint">
        {visible.length === 0
          ? 'Ничего не нашлось. Проверь запрос или впиши ID вручную.'
          : 'Выбери модель из списка или впиши ID вручную.'}
      </div>
    </>
  )
}

// The last screen's claim is computed in `finish.ts`, where it can be tested
// without mounting the wizard.

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
  /**
   * Writes run one after another.
   *
   * A model blur and a key save can overlap, and both answer with the whole
   * settings bundle: whichever lands last wins. Chaining them keeps the answer
   * the wizard stores equal to the last thing it asked for.
   */
  const saveQueue = useRef<Promise<unknown>>(Promise.resolve())
  const enqueue = useCallback(<T,>(task: () => Promise<T>): Promise<T> => {
    const next = saveQueue.current.then(task, task)
    saveQueue.current = next.then(
      () => undefined,
      () => undefined
    )
    return next
  }, [])

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
   * Writes only the fields the wizard edits.
   *
   * Sending the whole bundle would roll back anything changed in the settings
   * window while the wizard was open — the exact reason `connection.ts` builds
   * each save from the store's answer instead of the mount-time snapshot. A
   * field that was not part of this edit is not sent at all, so an untouched
   * half-typed Base URL cannot be replaced with an empty one either.
   */
  const persist = useCallback(
    async (changes: { model?: string; baseUrl?: string }) => {
      if (!bundle) return
      const patch: Partial<AppSettings> = { provider }
      if (changes.model !== undefined) {
        patch.models = { ...bundle.settings.models, [provider]: changes.model.trim() }
      }
      if (changes.baseUrl !== undefined) {
        patch.baseUrls = { ...bundle.settings.baseUrls, [provider]: changes.baseUrl }
      }
      try {
        setBundle(await enqueue(() => window.deskhand.settings.save(patch)))
      } catch {
        setNotice({ kind: 'err', text: 'Не удалось сохранить настройки.' })
      }
    },
    [bundle, enqueue, provider]
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
      // shows, and what the next provider's save builds on. Queued so a model
      // blur that landed mid-probe cannot overwrite this answer with an older one.
      const saved = await enqueue(() =>
        saveConnection(window.deskhand.settings, {
          provider,
          key,
          model,
          baseUrl: root
        })
      )
      setBundle(saved)
      setKeyInput('')
      setNotice({ kind: 'ok', text: test.message })
      await loadModels(root)
    } catch {
      setNotice({ kind: 'err', text: 'Не удалось сохранить ключ.' })
    } finally {
      setBusy(false)
    }
  }, [baseUrl, enqueue, keyInput, loadModels, model, provider])

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
  const finish = finishState(bundle, permissions, provider)

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
                disabled={busy || loadingModels}
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
                disabled={busy}
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
                  disabled={loadingModels || busy || baseUrlInvalid}
                  onClick={() => void loadModels(normalizeBaseUrl(baseUrl))}
                >
                  {loadingModels ? 'Загружаю…' : 'Загрузить модели'}
                </button>
              )}
            </div>

            <ModelControl
              providerLabel={providerLabel}
              model={model}
              models={models}
              modelsError={modelsError}
              query={modelQuery}
              busy={busy}
              onQuery={setModelQuery}
              onModel={setModel}
              onSave={(value) => {
                setModel(value)
                void persist({ model: value })
              }}
            />
          </div>

          {providerInfo(provider) && (
            <div className="hint">
              Ключ можно получить на{' '}
              <a href={providerInfo(provider)?.keyUrl} target="_blank" rel="noreferrer">
                {providerInfo(provider)?.keyUrl}
              </a>
            </div>
          )}

          <details className="disclosure" open={baseUrlInvalid || undefined}>
            <summary>Base URL</summary>
            <div className="field">
              <input
                value={baseUrl}
                disabled={busy}
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
            <button className="primary" disabled={busy || loadingModels} onClick={() => setStep(2)}>
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
            <button className="ghost" onClick={() => setStep(1)}>
              Назад
            </button>
            <div className="spacer" />
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
