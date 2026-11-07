/**
 * The «Модель» tab: provider, model, base URL override, key, sampling.
 *
 * Moved out of `App.tsx` verbatim. The only thing that changed is where the
 * derived values are computed: `info`, `status` and `baseUrlError` were already
 * read by nothing outside this section, so they are computed here instead of
 * being threaded through as props.
 *
 * The key field's own state stays in the window, not here: switching tabs
 * unmounts this section, and a half-typed key must not be thrown away by a
 * glance at «Поведение».
 */

import type { AppSettings, KeyStatus, ProviderId } from '@shared/types'
import { DEFAULT_SYSTEM_PROMPT, PROVIDERS, defaultSearchModel, normalizeBaseUrl, providerInfo } from '@shared/defaults'
import { MAX_TOKENS_MAX, MAX_TOKENS_MIN } from '../applyGate'

interface ProviderSectionProps {
  draft: AppSettings
  patch(changes: Partial<AppSettings>): void
  providerKeys: Record<ProviderId, KeyStatus | undefined>
  /** Providers whose base URL override is not an address — see `applyGate.ts`. */
  invalidBaseUrls: ProviderId[]
  keyInput: string
  onKeyInput(value: string): void
  testing: boolean
  onSaveKey(): void
  onRemoveKey(): void
}

export function ProviderSection({
  draft,
  patch,
  providerKeys,
  invalidBaseUrls,
  keyInput,
  onKeyInput,
  testing,
  onSaveKey,
  onRemoveKey
}: ProviderSectionProps) {
  const info = providerInfo(draft.provider)
  const status = providerKeys[draft.provider]
  const searchModel = draft.searchModels[draft.provider]
  const fallbackSearchModel = defaultSearchModel(draft)
  // An invalid override is rejected instead of being silently replaced by the
  // default, so a typo cannot quietly send traffic to the official host.
  const baseUrlError = invalidBaseUrls.includes(draft.provider)
    ? 'Некорректный адрес: нужен http(s)-адрес вида https://host/v1.'
    : null

  return (
    <section>
      <h2>Модель и ключ</h2>
      <p className="hint">
        Ключ хранится в связке ключей macOS (Keychain) и никогда не показывается целиком.
      </p>

      <div className="field">
        <label>Провайдер</label>
        <div className="segmented">
          {PROVIDERS.map((provider) => (
            <button
              key={provider.id}
              className={draft.provider === provider.id ? 'active' : ''}
              onClick={() => patch({ provider: provider.id })}
            >
              {provider.label}
              {providerKeys[provider.id]?.configured && <span className="badge">ключ</span>}
            </button>
          ))}
        </div>
      </div>

      <div className="field">
        <label>Модель</label>
        <input
          value={draft.models[draft.provider]}
          onChange={(event) =>
            patch({ models: { ...draft.models, [draft.provider]: event.target.value } })
          }
          placeholder={info?.defaultModel}
        />
        <div className="chips">
          {info?.popularModels.map((model) => (
            <button
              key={model}
              className="chip"
              onClick={() => patch({ models: { ...draft.models, [draft.provider]: model } })}
            >
              {model}
            </button>
          ))}
        </div>
      </div>

      <div className="field">
        <label htmlFor="search-model">Модель веб-поиска</label>
        <div className="key-row">
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
        <p className="hint">
          Укажите ID модели {info?.label} с поддержкой веб-поиска. Пустое поле — {fallbackSearchModel}.
        </p>
      </div>

      <div className="field">
        <label>Base URL · {info?.label}</label>
        <div className="key-row">
          <input
            value={draft.baseUrls[draft.provider]}
            onChange={(event) =>
              patch({ baseUrls: { ...draft.baseUrls, [draft.provider]: event.target.value } })
            }
            placeholder={info?.defaultBaseUrl}
            spellCheck={false}
          />
          <button
            className="ghost"
            disabled={!draft.baseUrls[draft.provider]}
            onClick={() => patch({ baseUrls: { ...draft.baseUrls, [draft.provider]: '' } })}
          >
            Сбросить
          </button>
        </div>
        {baseUrlError ? (
          <div className="hint err">{baseUrlError}</div>
        ) : (
          <div className="hint">
            {draft.baseUrls[draft.provider]
              ? `Запросы пойдут на ${normalizeBaseUrl(draft.baseUrls[draft.provider])}. Пустое поле — ${info?.defaultBaseUrl}.`
              : `Корень API, без /chat/completions. По умолчанию: ${info?.defaultBaseUrl}.`}
          </div>
        )}
      </div>

      <div className="field">
        <label>Ключ API {info?.label}</label>
        {status?.configured ? (
          <div className="key-row">
            <span className="ok">Ключ сохранён</span>
            <button onClick={onRemoveKey}>Удалить</button>
          </div>
        ) : (
          <div className="key-row">
            <input
              type="password"
              value={keyInput}
              onChange={(event) => onKeyInput(event.target.value)}
              placeholder="sk-…"
              onKeyDown={(event) => {
                if (event.key === 'Enter') onSaveKey()
              }}
            />
            <button
              className="primary"
              disabled={testing || !keyInput.trim()}
              onClick={onSaveKey}
            >
              {testing ? 'Проверка…' : 'Проверить и сохранить'}
            </button>
          </div>
        )}
        {info && (
          <div className="hint">
            Получить ключ:{' '}
            <a href={info.keyUrl} target="_blank" rel="noreferrer">
              {info.keyUrl}
            </a>
          </div>
        )}
      </div>

      <div className="row-grid">
        <div className="field">
          <label>Температура · {draft.temperature.toFixed(1)}</label>
          <input
            type="range"
            min={0}
            max={2}
            step={0.1}
            value={draft.temperature}
            onChange={(event) => patch({ temperature: Number(event.target.value) })}
          />
        </div>
        <div className="field">
          <label>Максимум токенов</label>
          <input
            type="number"
            min={MAX_TOKENS_MIN}
            max={MAX_TOKENS_MAX}
            step={MAX_TOKENS_MIN}
            value={draft.maxTokens}
            onChange={(event) => patch({ maxTokens: Number(event.target.value) })}
          />
        </div>
      </div>

      <div className="field">
        <label>Системный промпт</label>
        <textarea
          rows={4}
          value={draft.systemPrompt}
          onChange={(event) => patch({ systemPrompt: event.target.value })}
        />
        <div className="key-row">
          <span className="hint">
            Пустое поле не применяется: стереть промпт нельзя, только заменить.
          </span>
          <button
            className="ghost"
            disabled={draft.systemPrompt === DEFAULT_SYSTEM_PROMPT}
            onClick={() => patch({ systemPrompt: DEFAULT_SYSTEM_PROMPT })}
          >
            Вернуть стандартный
          </button>
        </div>
      </div>
    </section>
  )
}
