/**
 * The «Модель» tab: who answers, what it is given, and how it is reached.
 *
 * «Подключение» answers the four questions every setup answers, in the order they
 * come up: which service, which model, the key, and the address requests go to.
 * The address sits next to the key because a key pointed at the wrong host is
 * worth nothing — a proxy, a gateway and a local endpoint are the same decision.
 * Sampling and the system prompt are folded into «Дополнительно» — they are the
 * two things almost nobody changes, and leaving them open pushed the key field
 * below the fold on a laptop screen.
 *
 * The screenshot controls are here rather than on a tab of their own because
 * they answer the same question as the model picker: what does the model get to
 * look at.
 *
 * The key field's own state stays in the window, not here: switching tabs
 * unmounts this section, and a half-typed key must not be thrown away by a
 * glance at «Голос».
 */

import type { AppSettings, KeyStatus, ProviderId } from '@shared/types'
import { DEFAULT_SYSTEM_PROMPT, PROVIDERS, defaultSearchModel, normalizeBaseUrl, parseExtraBody, providerInfo } from '@shared/defaults'
import { MAX_TOKENS_MAX, MAX_TOKENS_MIN } from '../applyGate'
import { Disclosure, Group, Row, Toggle } from '../Row'

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
  const keyStatus = providerKeys[draft.provider]
  const searchModel = draft.searchModels[draft.provider]
  const fallbackSearchModel = defaultSearchModel(draft)
  // An invalid override is rejected instead of being silently replaced by the
  // default, so a typo cannot quietly send traffic to the official host.
  const baseUrlError = invalidBaseUrls.includes(draft.provider)
    ? 'Некорректный адрес: нужен http(s)-адрес вида https://host/v1.'
    : null
  const extraBodyError = parseExtraBody(draft.extraBody[draft.provider]) === null
    ? 'Нужен JSON-объект, например {"reasoning_effort": "none"}. Пока он не исправлен, параметры не отправляются.'
    : null

  return (
    <div className="pane">
      <Group title="Подключение">
        <Row stacked title="Сервис">
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
        </Row>

        <Row
          stacked
          title="Модель"
          hint={
            info
              ? `ID модели ${info.label}. Пусто — ${info.defaultModel}.`
              : 'ID модели провайдера.'
          }
        >
          <input
            value={draft.models[draft.provider]}
            onChange={(event) =>
              patch({ models: { ...draft.models, [draft.provider]: event.target.value } })
            }
            placeholder={info?.defaultModel}
            spellCheck={false}
          />
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
              <button className="ghost" onClick={onRemoveKey}>
                Удалить
              </button>
            </div>
          ) : (
            <div className="row-actions">
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
            <div className="row-hint">
              Получить:{' '}
              <a href={info.keyUrl} target="_blank" rel="noreferrer">
                {info.keyUrl}
              </a>
            </div>
          )}
        </Row>

        <Row
          stacked
          title={`Base URL · ${info?.label ?? ''}`}
          hint={
            draft.baseUrls[draft.provider]
              ? `Запросы идут на ${normalizeBaseUrl(draft.baseUrls[draft.provider])}.`
              : `Корень API без /chat/completions. По умолчанию: ${info?.defaultBaseUrl}.`
          }
        >
          <div className="row-actions">
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
          {baseUrlError && <div className="row-hint err">{baseUrlError}</div>}
        </Row>
      </Group>

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
            'смотря что понимает ваш сервис.'
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
                min={480}
                max={2400}
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
                min={30}
                max={95}
                step={5}
                value={draft.screenshotQuality}
                aria-label="Качество JPEG"
                onChange={(event) => patch({ screenshotQuality: Number(event.target.value) })}
              />
            </div>
          </div>
        </Row>
      </Group>

      <Disclosure title="Дополнительно">
        <div className="row-grid">
          <div>
            <div className="row-hint">Температура · {draft.temperature.toFixed(1)}</div>
            <input
              type="range"
              min={0}
              max={2}
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
              min={MAX_TOKENS_MIN}
              max={MAX_TOKENS_MAX}
              step={MAX_TOKENS_MIN}
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
  )
}
