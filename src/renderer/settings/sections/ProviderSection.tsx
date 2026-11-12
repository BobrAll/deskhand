import { useEffect, useId, useRef, useState } from 'react'
import type { AppSettings, KeyStatus, ModelListResult, ProviderId } from '@shared/types'
import { DEFAULT_SYSTEM_PROMPT, PROVIDERS, SETTINGS_BOUNDS, normalizeBaseUrl, parseExtraBody, providerInfo, searchModelFallback } from '@shared/defaults'
import { Disclosure, Group, Row, Toggle } from '../Row'

interface ProviderSectionProps {
  draft: AppSettings
  patch(changes: Partial<AppSettings>): void
  providerKeys: Record<ProviderId, KeyStatus | undefined>
  /** Providers whose base URL override is not an address — see `applyGate.ts`. */
  invalidBaseUrls: ProviderId[]
  keyInput: string
  onKeyInput(value: string): void
  onSaveKey(): Promise<boolean>
  onRemoveKey(): Promise<void>
}

const MODEL_VIEWS = [
  { id: 'connection', label: 'Подключение' },
  { id: 'models', label: 'Выбор модели' },
  { id: 'screenshot', label: 'Скриншот' }
] as const

export function ProviderSection({
  draft,
  patch,
  providerKeys,
  invalidBaseUrls,
  keyInput,
  onKeyInput,
  onSaveKey,
  onRemoveKey
}: ProviderSectionProps) {
  const navId = useId()
  const [view, setView] = useState<(typeof MODEL_VIEWS)[number]['id']>('connection')
  const [busy, setBusy] = useState(false)
  const [catalog, setCatalog] = useState<ModelListResult | null>(null)
  const modelListRef = useRef<HTMLSelectElement>(null)
  const modelIdRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (view === 'models' && catalog) {
      (catalog.ok ? modelListRef.current : modelIdRef.current)?.focus()
    }
  }, [view, catalog])

  const provider = draft.provider
  const baseUrl = draft.baseUrls[provider]
  const model = draft.models[provider]
  const info = providerInfo(draft.provider)
  const keyStatus = providerKeys[draft.provider]
  const searchModel = draft.searchModels[draft.provider]
  const fallbackSearchModel = searchModelFallback(draft)
  // An invalid override is rejected instead of being silently replaced by the
  // default, so a typo cannot quietly send traffic to the official host.
  const baseUrlError = invalidBaseUrls.includes(draft.provider)
    ? 'Некорректный адрес: нужен http(s)-адрес вида https://host/v1.'
    : null
  const extraBodyError = parseExtraBody(draft.extraBody[draft.provider]) === null
    ? 'Нужен JSON-объект, например {"reasoning_effort": "none"}. Пока он не исправлен, параметры не отправляются.'
    : null

  const chooseModel = (value: string) => patch({ models: { ...draft.models, [provider]: value } })

  async function saveOrLoad(load: boolean) {
    setBusy(true)
    try {
      if (!keyStatus?.configured && !await onSaveKey()) return
      if (!load) return
      setCatalog(null)
      const result = await window.deskhand.settings.listModels(provider, baseUrl)
      setCatalog(result)
      setView((current) => current === 'connection' ? 'models' : current)
    } catch {
      setCatalog({ ok: false, message: 'Не удалось загрузить список моделей.' })
      setView((current) => current === 'connection' ? 'models' : current)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="pane">
      <nav className="segmented settings-subnav" aria-label="Настройки модели">
        {MODEL_VIEWS.map(({ id, label }) => (
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

      <div className="model-view" id={`${navId}-connection`} hidden={view !== 'connection'}>
        <Group>
          <Row stacked title="Сервис">
            <div className="segmented">
              {PROVIDERS.map((provider) => (
                <button
                  key={provider.id}
                  className={draft.provider === provider.id ? 'active' : ''}
                  disabled={busy}
                  onClick={() => {
                    if (provider.id === draft.provider) return
                    setCatalog(null)
                    onKeyInput('')
                    patch({ provider: provider.id })
                  }}
                >
                  {provider.label}
                  {providerKeys[provider.id]?.configured && <span className="badge">ключ</span>}
                </button>
              ))}
            </div>
          </Row>

          <Row
            stacked
            title={`Ключ API ${info?.label ?? ''}`.trim()}
            hint={
              keyStatus?.configured
                ? 'Ключ лежит в Keychain и никогда не показывается целиком.'
                : undefined
            }
          >
            {keyStatus?.configured ? (
              <div className="row-actions">
                <span className="permission-state ok">● Ключ сохранён</span>
                <button
                  className="ghost"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true)
                    setCatalog(null)
                    try {
                      await onRemoveKey()
                    } finally {
                      setBusy(false)
                    }
                  }}
                >
                  Удалить
                </button>
              </div>
            ) : (
              <div className="row-actions">
                <input
                  type="password"
                  aria-label="Ключ API"
                  disabled={busy}
                  value={keyInput}
                  onChange={(event) => onKeyInput(event.target.value)}
                  placeholder="sk-…"
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && keyInput.trim() && !busy) void saveOrLoad(!baseUrlError)
                  }}
                />
                <button
                  disabled={busy || !keyInput.trim()}
                  onClick={() => void saveOrLoad(false)}
                >
                  Сохранить ключ
                </button>
              </div>
            )}
          </Row>

          <Disclosure title="Base URL">
            <div className="row-hint">
              {baseUrl && !baseUrlError
                ? `Запросы идут на ${normalizeBaseUrl(baseUrl)}.`
                : 'Необязательно. Пустое поле использует адрес сервиса по умолчанию.'}
            </div>
            <div className="row-actions">
              <input
                aria-label="Base URL"
                disabled={busy}
                value={baseUrl}
                onChange={(event) => {
                  setCatalog(null)
                  patch({ baseUrls: { ...draft.baseUrls, [provider]: event.target.value } })
                }}
                placeholder={info?.defaultBaseUrl}
                spellCheck={false}
              />
              <button
                className="ghost"
                disabled={busy || !baseUrl}
                onClick={() => {
                  setCatalog(null)
                  patch({ baseUrls: { ...draft.baseUrls, [provider]: '' } })
                }}
              >
                Сбросить
              </button>
            </div>
          </Disclosure>
          {baseUrlError && (
            <Row hint={<span className="row-hint err" role="status">{baseUrlError}</span>} />
          )}
          <Row>
            <button
              className="primary"
              disabled={busy || Boolean(baseUrlError) || (!keyStatus?.configured && !keyInput.trim())}
              onClick={() => void saveOrLoad(true)}
            >
              {busy ? 'Подожди…' : keyStatus?.configured ? 'Загрузить модели' : 'Сохранить ключ и загрузить модели'}
            </button>
          </Row>
        </Group>
      </div>

      <div className="model-view" id={`${navId}-models`} hidden={view !== 'models'}>
        <Group title="Выбор модели">
          {catalog?.ok ? (
            <Row stacked title="Модели сервиса">
              <select
                ref={modelListRef}
                aria-label="Модели сервиса"
                value={catalog.models.includes(model) ? model : ''}
                onChange={(event) => {
                  if (event.target.value) chooseModel(event.target.value)
                }}
              >
                <option value="" disabled>Выбери из списка</option>
                {catalog.models.map((id) => <option key={id} value={id}>{id}</option>)}
              </select>
            </Row>
          ) : (
            <Row stacked hint={
              catalog
                ? <span role="status">{catalog.message} Введи ID модели вручную или повтори загрузку.</span>
                : 'Загрузи список в «Подключении» или введи ID модели.'
            }>
              <button onClick={() => setView('connection')}>Открыть подключение</button>
            </Row>
          )}
          <Row stacked title="ID модели вручную">
            <input
              ref={modelIdRef}
              aria-label="ID модели вручную"
              value={model}
              onChange={(event) => chooseModel(event.target.value)}
              spellCheck={false}
            />
          </Row>
        </Group>

        <Disclosure title="Дополнительно">
          <Group title="Поиск в интернете">
            <Row
              stacked
              title="Модель веб-поиска"
              hint={`Пустое поле — ${fallbackSearchModel}.`}
            >
              <div className="row-actions">
                <input
                  id="search-model"
                  value={searchModel}
                  onChange={(event) =>
                    patch({ searchModels: { ...draft.searchModels, [draft.provider]: event.target.value } })
                  }
                  placeholder={fallbackSearchModel}
                  spellCheck={false}
                />
                <button
                  className="ghost"
                  disabled={!searchModel}
                  onClick={() => patch({ searchModels: { ...draft.searchModels, [draft.provider]: '' } })}
                >
                  Сбросить
                </button>
              </div>
            </Row>
          </Group>

          <Group title="Запрос">
            <Row
              stacked
              title={`Доп. параметры запроса · ${info?.label ?? ''}`}
              hint={
                'JSON-объект, который добавляется в тело каждого запроса к модели. ' +
                'Например, {"reasoning_effort": "none"} или {"thinking": {"type": "disabled"}} — ' +
                'смотря что понимает твой сервис.'
              }
            >
              <textarea
                className="extra-body"
                rows={1}
                value={draft.extraBody[draft.provider]}
                aria-label="Дополнительные параметры запроса"
                placeholder='{"reasoning_effort": "none"}'
                spellCheck={false}
                onChange={(event) =>
                  patch({ extraBody: { ...draft.extraBody, [draft.provider]: event.target.value } })
                }
              />
              {extraBodyError && <div className="row-hint err">{extraBodyError}</div>}
            </Row>
          </Group>
          <div className="row-grid">
            <div>
              <div className="row-hint">Температура · {draft.temperature.toFixed(1)}</div>
              <input
                type="range"
                min={SETTINGS_BOUNDS.temperature.min}
                max={SETTINGS_BOUNDS.temperature.max}
                step={0.1}
                value={draft.temperature}
                aria-label="Температура"
                onChange={(event) => patch({ temperature: Number(event.target.value) })}
              />
            </div>
            <div>
              <div className="row-hint">Максимум токенов</div>
              <input
                type="number"
                min={SETTINGS_BOUNDS.maxTokens.min}
                max={SETTINGS_BOUNDS.maxTokens.max}
                step={SETTINGS_BOUNDS.maxTokens.min}
                value={draft.maxTokens}
                aria-label="Максимум токенов"
                onChange={(event) => patch({ maxTokens: Number(event.target.value) })}
              />
            </div>
          </div>

          <div>
            <div className="row-hint">Системный промпт</div>
            <textarea
              rows={4}
              value={draft.systemPrompt}
              aria-label="Системный промпт"
              onChange={(event) => patch({ systemPrompt: event.target.value })}
            />
            <div className="row-actions">
              <span className="row-hint">Пустой промпт не применяется.</span>
              <button
                className="ghost"
                disabled={draft.systemPrompt === DEFAULT_SYSTEM_PROMPT}
                onClick={() => patch({ systemPrompt: DEFAULT_SYSTEM_PROMPT })}
              >
                Вернуть стандартный
              </button>
            </div>
          </div>
        </Disclosure>
      </div>

      <div className="model-view" id={`${navId}-screenshot`} hidden={view !== 'screenshot'}>
        <Group title="Скриншот">
          <Row
            title="Снимать экран, когда нет выделения"
            hint="Ассистент сам решит, что обвести и куда показать стрелкой."
          >
            <Toggle
              checked={draft.captureScreenshotByDefault}
              label="Снимать экран, когда нет выделения"
              onChange={(captureScreenshotByDefault) => patch({ captureScreenshotByDefault })}
            />
          </Row>

          <Row stacked title="Размер и качество" hint="Меньше — быстрее ответ и дешевле.">
            <div className="row-grid">
              <div>
                <div className="row-hint">Длинная сторона · {draft.screenshotMaxSide}px</div>
                <input
                  type="range"
                  min={SETTINGS_BOUNDS.screenshotMaxSide.min}
                  max={SETTINGS_BOUNDS.screenshotMaxSide.max}
                  step={80}
                  value={draft.screenshotMaxSide}
                  aria-label="Длинная сторона скриншота"
                  onChange={(event) => patch({ screenshotMaxSide: Number(event.target.value) })}
                />
              </div>
              <div>
                <div className="row-hint">Качество JPEG · {draft.screenshotQuality}</div>
                <input
                  type="range"
                  min={SETTINGS_BOUNDS.screenshotQuality.min}
                  max={SETTINGS_BOUNDS.screenshotQuality.max}
                  step={5}
                  value={draft.screenshotQuality}
                  aria-label="Качество JPEG"
                  onChange={(event) => patch({ screenshotQuality: Number(event.target.value) })}
                />
              </div>
            </div>
          </Row>
        </Group>
      </div>
    </div>
  )
}
