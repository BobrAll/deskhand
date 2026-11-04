/**
 * Settings window (ТЗ §7). Six sections: провайдер и ключи, поведение, голос,
 * агент, быстрые действия, исключения и права.
 *
 * There is no «Сохранить»: every field is written as it is edited. The button was
 * the reason a ticked checkbox could sit in a draft while the rest of the app
 * behaved as if it had never been ticked — which is exactly how "я же включил, а
 * он всё равно не нажимает" happened. What replaces it is not a promise but a
 * state line in the footer, and the two guards below: a write is held while a
 * field is mid-edit, and a window close waits for the last write to land.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AppSettings, KeyStatus, PermissionState, ProviderId, QuickAction } from '@shared/types'
import { DEFAULT_SYSTEM_PROMPT, PROVIDERS, normalizeBaseUrl, providerInfo } from '@shared/defaults'
import type { AppPickResult, RunningAppInfo, SettingsBundle } from '@shared/api'
import { HotkeyField, prettyHotkey } from './HotkeyField'
import { AgentTab } from './AgentTab'
import { VoiceTab } from './VoiceTab'

type Tab = 'provider' | 'behavior' | 'voice' | 'agent' | 'actions' | 'privacy'

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'provider', label: 'Модель' },
  { id: 'behavior', label: 'Поведение' },
  { id: 'voice', label: 'Голос' },
  { id: 'agent', label: 'Агент' },
  { id: 'actions', label: 'Быстрые действия' },
  { id: 'privacy', label: 'Приватность' }
]

interface Banner {
  kind: 'ok' | 'err'
  text: string
}

/**
 * Where a change is on its way to disk.
 *
 * The window has no «Сохранить» any more: everything is written as it is edited.
 * That removes a whole class of "я же поставил галочку" bugs, but it also means
 * the footer has to be honest about the three states that are not "done" — a
 * change still waiting for the debounce, one that is in flight, and one the
 * settings themselves refuse (an invalid base URL, an empty prompt field).
 */
type ApplyState = 'idle' | 'pending' | 'saving' | 'saved' | 'held' | 'error'

/**
 * Values the settings window cannot store as they are, and what it says instead.
 *
 * These are not "invalid input" warnings in the usual sense — they are the cases
 * where the normaliser on the other side would silently replace what is on screen
 * (an empty prompt becomes the default one, a half-typed token count is clamped,
 * a quick action without a prompt is dropped). Writing those through would fight
 * the user's keyboard, so the write waits until the field is finished.
 */
const HOLD_REASON = {
  baseUrl: 'Проверьте адрес API — изменения не применены.',
  maxTokens: 'Максимум токенов: от 64 до 8192.',
  prompt: 'Пустой системный промпт оставлен прежним.',
  quickAction: 'У быстрого действия не хватает названия или промпта.',
  hotkey: 'Горячая клавиша не задана.'
} as const

function holdReasonFor(draft: AppSettings, invalidBaseUrls: ProviderId[]): string | null {
  if (invalidBaseUrls.length > 0) return HOLD_REASON.baseUrl
  // Out of range, not merely odd: a cleared number field reads as 0 while the
  // user is retyping it, and clamping that would rewrite the field under them.
  if (!Number.isFinite(draft.maxTokens) || draft.maxTokens < 64 || draft.maxTokens > 8192) {
    return HOLD_REASON.maxTokens
  }
  if (!draft.systemPrompt.trim()) return HOLD_REASON.prompt
  if (!draft.hotkey.trim()) return HOLD_REASON.hotkey
  if (draft.quickActions.some((action) => !action.label.trim() || !action.prompt.trim())) {
    return HOLD_REASON.quickAction
  }
  return null
}

export function App() {
  const [bundle, setBundle] = useState<SettingsBundle | null>(null)
  const [draft, setDraft] = useState<AppSettings | null>(null)
  const [tab, setTab] = useState<Tab>('provider')
  const [banner, setBanner] = useState<Banner | null>(null)
  const [applyState, setApplyState] = useState<ApplyState>('idle')

  const [keyInput, setKeyInput] = useState('')
  const [testing, setTesting] = useState(false)
  const [apps, setApps] = useState<RunningAppInfo[]>([])
  const [hotkeyError, setHotkeyError] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  useEffect(() => {
    // A rejected `load()` used to leave the window spinning on "Загрузка…"
    // forever, which looks like an empty settings window.
    void window.smartCursor.settings
      .load()
      .then((loaded) => {
        setBundle(loaded)
        setDraft(loaded.settings)
      })
      .catch((error: unknown) => {
        console.error('[settings] load failed:', error)
        setLoadError(
          error instanceof Error ? error.message : 'Не удалось загрузить настройки.'
        )
      })
    void window.smartCursor.settings
      .runningApps()
      .then(setApps)
      .catch(() => setApps([]))
  }, [])

  const providerKeys = useMemo<Record<ProviderId, KeyStatus | undefined>>(() => {
    const map = {} as Record<ProviderId, KeyStatus | undefined>
    for (const info of PROVIDERS) {
      map[info.id] = bundle?.keys.find((key) => key.provider === info.id)
    }
    return map
  }, [bundle])

  const patch = useCallback((changes: Partial<AppSettings>) => {
    setDraft((prev) => (prev ? { ...prev, ...changes } : prev))
  }, [])

  const invalidBaseUrls = useMemo(() => {
    if (!draft) return [] as ProviderId[]
    return PROVIDERS.filter(
      (provider) =>
        draft.baseUrls[provider.id].trim() !== '' &&
        normalizeBaseUrl(draft.baseUrls[provider.id]) === ''
    ).map((provider) => provider.id)
  }, [draft])

  const holdReason = useMemo(
    () => (draft ? holdReasonFor(draft, invalidBaseUrls) : null),
    [draft, invalidBaseUrls]
  )

  /**
   * What was last written, verbatim.
   *
   * Auto-apply compares the draft with the saved bundle to decide whether there is
   * anything left to do. That comparison lies whenever the store normalises a
   * value — a trailing slash on a base URL, a temperature of 0.35 stored as 0.35
   * but a stray space trimmed — because the draft then differs from what was just
   * saved while the user has not touched anything. Without this, the window would
   * rewrite the same settings every 450 ms for as long as it stayed open.
   */
  const writtenRef = useRef<string | null>(null)

  /**
   * The snapshot a failed write was for, so it is not retried in a loop.
   *
   * Without this, a write that throws leaves the draft different from the bundle,
   * the effect sees work to do, waits 450 ms, fails again — forever, once every
   * half second, for as long as the window is open. One failure is reported; the
   * next attempt happens when the user changes something, presses ⌘S or closes.
   */
  const failedRef = useRef<string | null>(null)

  /**
   * Writes one snapshot of the draft.
   *
   * `snapshot` is passed in rather than read from state: a write is triggered by
   * a timer, and the draft at the moment the timer fires may already be newer
   * than the change it was scheduled for. The comparison after the round trip is
   * what keeps a slow disk from clobbering keys the user has typed since.
   */
  const flush = useCallback(async (snapshot: AppSettings): Promise<boolean> => {
    const written = JSON.stringify(snapshot)
    setApplyState('saving')
    try {
      const saved = await window.smartCursor.settings.save(snapshot)
      setBundle(saved)
      writtenRef.current = written
      failedRef.current = null
      const hotkeyError = Boolean(saved.hotkeyError)
      setDraft((current) => {
        if (!current) return current
        // A rejected hotkey comes back with the previous binding restored, and the
        // draft has to follow it: keeping the rejected combination would leave the
        // window retrying a write the system refuses, forever.
        if (hotkeyError) return { ...current, hotkey: saved.settings.hotkey }
        return JSON.stringify(current) === written ? saved.settings : current
      })
      if (hotkeyError) {
        // The rejected binding is the one thing that did not land, so the write
        // snapshot must not be remembered: the draft is about to be dragged back
        // to the stored hotkey, and treating the refused combination as "already
        // applied" would hide a retry that can never succeed.
        writtenRef.current = null
        setHotkeyError('Комбинация занята — оставлена прежняя.')
        setApplyState('error')
        setBanner({ kind: 'err', text: 'Не удалось назначить горячую клавишу.' })
        window.setTimeout(() => setBanner(null), 2600)
        return false
      }
      setHotkeyError(null)
      setApplyState('saved')
      return true
    } catch {
      // Nothing reached the disk, so a later change must be allowed to try again —
      // but this exact snapshot must not, or the timer would retry it every 450 ms
      // for as long as the window stayed open.
      writtenRef.current = null
      failedRef.current = written
      setApplyState('error')
      setBanner({ kind: 'err', text: 'Не удалось сохранить настройки.' })
      window.setTimeout(() => setBanner(null), 2600)
      return false
    }
  }, [])

  /**
   * Applies the draft as it is edited.
   *
   * 450 ms of quiet: long enough that a typed model name is not written letter by
   * letter, short enough that a checkbox feels like it did something. The timer
   * is cleared on every new keystroke by the effect's own cleanup.
   */
  useEffect(() => {
    if (!draft || !bundle) return
    const current = JSON.stringify(draft)
    if (current === JSON.stringify(bundle.settings) || current === writtenRef.current) {
      // Nothing to write. `saved` is kept so the footer can say "Применено"
      // instead of blinking back to an empty line the moment the write lands.
      setApplyState((state) => (state === 'saved' ? state : 'idle'))
      return
    }
    if (current === failedRef.current) {
      // Already reported once. Retrying the identical write on a timer produces
      // the same failure every half second and never tells the user anything new;
      // the next edit, ⌘S or closing the window starts a fresh attempt.
      setApplyState('error')
      return
    }
    if (holdReason) {
      setApplyState('held')
      return
    }
    setApplyState('pending')
    const timer = window.setTimeout(() => {
      void flush(draft)
    }, 450)
    return () => window.clearTimeout(timer)
  }, [draft, bundle, holdReason, flush])

  /**
   * Tells the main process that a write is still coming.
   *
   * ⌘W is how a window gets closed, and it lands in the 450 ms between the last
   * keystroke and the write. Without this the window would be destroyed with the
   * edit still in React state — the exact bug the missing save button was
   * supposed to make impossible, just moved into a smaller window.
   */
  useEffect(() => {
    window.smartCursor.settings.hold(applyState === 'pending' || applyState === 'saving')
  }, [applyState])

  /** Whether the draft holds anything that is not on disk yet. */
  const unsaved = useCallback(
    (value: AppSettings): boolean =>
      !bundle ||
      (JSON.stringify(value) !== JSON.stringify(bundle.settings) &&
        JSON.stringify(value) !== writtenRef.current),
    [bundle]
  )

  /**
   * The draft as it can actually be written, for the explicit paths (⌘S, closing).
   *
   * Two kinds of values cannot go through as they stand, and they are handled
   * differently on purpose:
   *
   * - a quick action row that was just added and is still empty is simply not a
   *   quick action yet; the store drops it anyway, so dropping it here lets the
   *   rest of the write proceed;
   * - a field that is mid-edit (a half-typed token count, an address that is not
   *   a URL yet) is *reverted to what is on disk* instead. Writing it would make
   *   the store replace it silently — 0 becomes 64, junk becomes "" — and the
   *   window would then show a value that is not the one being used.
   */
  const writable = useCallback(
    (value: AppSettings): AppSettings => {
      const next: AppSettings = {
        ...value,
        quickActions: value.quickActions.filter(
          (action) => action.label.trim() && action.prompt.trim()
        )
      }
      if (!bundle) return next
      const onDisk = bundle.settings
      if (invalidBaseUrls.length > 0) next.baseUrls = onDisk.baseUrls
      if (!Number.isFinite(next.maxTokens) || next.maxTokens < 64 || next.maxTokens > 8192) {
        next.maxTokens = onDisk.maxTokens
      }
      if (!next.systemPrompt.trim()) next.systemPrompt = onDisk.systemPrompt
      if (!next.hotkey.trim()) next.hotkey = onDisk.hotkey
      return next
    },
    [bundle, invalidBaseUrls]
  )

  /** Closing the window is not a reason to lose the last half-second of typing. */
  const closeWindow = useCallback(async () => {
    if (draft && unsaved(draft)) {
      // An explicit close is the user asking for it to be stored, even if the
      // automatic attempt for this exact snapshot already failed.
      failedRef.current = null
      await flush(writable(draft))
    }
    window.smartCursor.settings.close()
  }, [draft, unsaved, writable, flush])

  /**
   * ⌘S still works, it just is not required any more.
   *
   * The habit is older than the window, and without this it would open macOS's
   * own "Save page" dialog over the settings — so the shortcut is kept as "write
   * it right now, skip the debounce", which is also the honest meaning of the
   * gesture in a window that saves itself.
   */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 's') return
      event.preventDefault()
      if (draft && unsaved(draft)) {
        failedRef.current = null
        void flush(writable(draft))
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [draft, unsaved, writable, flush])

  const saveKey = useCallback(async () => {
    if (!draft || !keyInput.trim()) return
    setTesting(true)
    try {
      const test = await window.smartCursor.settings.testKey(
        draft.provider,
        keyInput,
        draft.baseUrls[draft.provider]
      )
      if (!test.ok) {
        setBanner({ kind: 'err', text: test.message })
        return
      }
      const next = await window.smartCursor.settings.setKey(draft.provider, keyInput)
      setBundle(next)
      setKeyInput('')
      setBanner({ kind: 'ok', text: test.message })
    } catch {
      setBanner({ kind: 'err', text: 'Не удалось сохранить ключ.' })
    } finally {
      setTesting(false)
      window.setTimeout(() => setBanner(null), 3600)
    }
  }, [draft, keyInput])

  const removeKey = useCallback(async () => {
    if (!draft) return
    const next = await window.smartCursor.settings.deleteKey(draft.provider)
    setBundle(next)
    setBanner({ kind: 'ok', text: 'Ключ удалён' })
    window.setTimeout(() => setBanner(null), 2200)
  }, [draft])

  const addExcluded = useCallback(
    async (picked: AppPickResult | null) => {
      if (!picked || !draft) return
      if (draft.excludedApps.includes(picked.bundleId)) return
      patch({ excludedApps: [...draft.excludedApps, picked.bundleId] })
    },
    [draft, patch]
  )

  const permissions: PermissionState | null = bundle?.permissions ?? null

  if (loadError) {
    return (
      <div className="pending">
        <div>Не удалось загрузить настройки.</div>
        <div className="hint">{loadError}</div>
        <button className="primary" onClick={() => window.location.reload()}>
          Повторить
        </button>
      </div>
    )
  }

  if (!draft || !bundle) {
    return <div className="pending">Загрузка настроек…</div>
  }

  const info = providerInfo(draft.provider)
  const status = providerKeys[draft.provider]
  // An invalid override is rejected instead of being silently replaced by the
  // default, so a typo cannot quietly send traffic to the official host.
  const baseUrlError = invalidBaseUrls.includes(draft.provider)
    ? 'Некорректный адрес: нужен http(s)-адрес вида https://host/v1.'
    : null

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">Smart Cursor</div>
        {TABS.map((item) => (
          <button
            key={item.id}
            className={`nav ${tab === item.id ? 'active' : ''}`}
            onClick={() => setTab(item.id)}
          >
            {item.label}
          </button>
        ))}
        <div className="sidebar-foot">
          <div className="hint">Карточка</div>
          <div className="hotkey-badge">{prettyHotkey(draft.hotkey)}</div>
          {draft.voice.enabled && (
            <>
              <div className="hint" style={{ marginTop: 8 }}>
                Голос
              </div>
              <div className="hotkey-badge">{prettyHotkey(draft.voice.hotkey)}</div>
            </>
          )}
        </div>
      </aside>

      <main className="content">
        {tab === 'provider' && (
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
                  onClick={() =>
                    patch({ baseUrls: { ...draft.baseUrls, [draft.provider]: '' } })
                  }
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
                  <button onClick={() => void removeKey()}>Удалить</button>
                </div>
              ) : (
                <div className="key-row">
                  <input
                    type="password"
                    value={keyInput}
                    onChange={(event) => setKeyInput(event.target.value)}
                    placeholder="sk-…"
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') void saveKey()
                    }}
                  />
                  <button className="primary" disabled={testing || !keyInput.trim()} onClick={() => void saveKey()}>
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
                  min={64}
                  max={8192}
                  step={64}
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
        )}

        {tab === 'behavior' && (
          <section>
            <h2>Поведение</h2>

            <div className="field">
              <label>Глобальная горячая клавиша</label>
              <HotkeyField
                value={draft.hotkey}
                onChange={(accelerator) => {
                  setHotkeyError(null)
                  patch({ hotkey: accelerator })
                }}
              />
              {hotkeyError && <div className="hint err">{hotkeyError}</div>}
            </div>

            <label className="check">
              <input
                type="checkbox"
                checked={draft.captureScreenshotByDefault}
                onChange={(event) => patch({ captureScreenshotByDefault: event.target.checked })}
              />
              Делать скриншот, когда нет выделения — по нему ассистент сам решает,
              что обвести и куда показать стрелкой
            </label>

            <label className="check">
              <input
                type="checkbox"
                checked={draft.launchAtLogin}
                onChange={(event) => patch({ launchAtLogin: event.target.checked })}
              />
              Запускать при входе в систему
            </label>

            <div className="row-grid">
              <div className="field">
                <label>Длинная сторона скриншота · {draft.screenshotMaxSide}px</label>
                <input
                  type="range"
                  min={480}
                  max={2400}
                  step={80}
                  value={draft.screenshotMaxSide}
                  onChange={(event) => patch({ screenshotMaxSide: Number(event.target.value) })}
                />
              </div>
              <div className="field">
                <label>Качество JPEG · {draft.screenshotQuality}</label>
                <input
                  type="range"
                  min={30}
                  max={95}
                  step={5}
                  value={draft.screenshotQuality}
                  onChange={(event) => patch({ screenshotQuality: Number(event.target.value) })}
                />
              </div>
            </div>

            <div className="hint">
              Меньше длинная сторона и качество — быстрее ответ и меньше расход токенов.
            </div>
          </section>
        )}

        {tab === 'voice' && (
          <VoiceTab
            voice={draft.voice}
            gestures={draft.gestures}
            onChange={(changes) => patch({ voice: { ...draft.voice, ...changes } })}
            onGestureChange={(changes) =>
              patch({ gestures: { ...draft.gestures, ...changes } })
            }
          />
        )}

        {tab === 'agent' && (
          <AgentTab
            agent={draft.agent}
            onChange={(changes) => patch({ agent: { ...draft.agent, ...changes } })}
            onEnabledChange={async (enabled) => {
              // Written through the dedicated channel, not the draft: this switch
              // decides whether the assistant can act at all, and it has to be on
              // disk before the answer that arrives a second later. The debounced
              // autosave would also get there, 450 ms too late.
              const availability = await window.smartCursor.agent.setEnabled(enabled)
              // The bundle is the "saved" side of the auto-apply comparison;
              // syncing it keeps the footer from announcing a pending write for a
              // value that is already on disk.
              setBundle((prev) =>
                prev
                  ? { ...prev, settings: { ...prev.settings, agent: { ...prev.settings.agent, enabled } } }
                  : prev
              )
              return availability
            }}
          />
        )}

        {tab === 'actions' && (
          <section>
            <h2>Быстрые действия</h2>
            <p className="hint">Порядок кнопок в оверлее. Пустые поля игнорируются.</p>
            <QuickActionsEditor
              actions={draft.quickActions}
              onChange={(quickActions) => patch({ quickActions })}
            />
          </section>
        )}

        {tab === 'privacy' && (
          <section>
            <h2>Приватность и доступ</h2>

            <div className="permissions">
              <PermissionRow
                title="Универсальный доступ"
                description="Нужен, чтобы читать выделенный текст и вставлять ответ."
                granted={permissions?.accessibility ?? false}
                onRequest={async () => {
                  const next = await window.smartCursor.permissions.request()
                  setBundle((prev) => (prev ? { ...prev, permissions: next } : prev))
                }}
                onOpen={() => window.smartCursor.permissions.open('accessibility')}
              />
              <PermissionRow
                title="Запись экрана"
                description="Нужна для скриншота активного окна."
                granted={permissions?.screenRecording ?? false}
                onRequest={async () => {
                  const next = await window.smartCursor.permissions.request()
                  setBundle((prev) => (prev ? { ...prev, permissions: next } : prev))
                }}
                onOpen={() => window.smartCursor.permissions.open('screenRecording')}
              />
              <PermissionRow
                title="Микрофон"
                description="Нужен для голосового ввода: удержание клавиши записывает речь."
                granted={permissions?.microphone ?? false}
                onRequest={async () => {
                  const granted = await window.smartCursor.permissions.requestMicrophone()
                  setBundle((prev) =>
                    prev ? { ...prev, permissions: { ...prev.permissions, microphone: granted } } : prev
                  )
                }}
                onOpen={() => window.smartCursor.permissions.open('microphone')}
              />
            </div>

            <div className="field">
              <label>Исключённые приложения</label>
              <p className="hint">
                В этих приложениях Smart Cursor не читает текст и не делает скриншоты.
              </p>
              <div className="excluded-list">
                {draft.excludedApps.map((bundleId) => (
                  <div key={bundleId} className="excluded-row">
                    <span className="mono">{bundleId}</span>
                    <button
                      className="ghost"
                      onClick={() =>
                        patch({
                          excludedApps: draft.excludedApps.filter((item) => item !== bundleId)
                        })
                      }
                    >
                      ✕
                    </button>
                  </div>
                ))}
                {draft.excludedApps.length === 0 && <div className="hint">Список пуст.</div>}
              </div>
              <div className="key-row">
                <select
                  value=""
                  onChange={(event) => {
                    const bundleId = event.target.value
                    if (bundleId && !draft.excludedApps.includes(bundleId)) {
                      patch({ excludedApps: [...draft.excludedApps, bundleId] })
                    }
                  }}
                >
                  <option value="">Выбрать из запущенных…</option>
                  {apps
                    .filter((app) => !draft.excludedApps.includes(app.bundleId))
                    .map((app) => (
                      <option key={app.bundleId} value={app.bundleId}>
                        {app.name}
                      </option>
                    ))}
                </select>
                <button
                  onClick={async () => {
                    const picked = await window.smartCursor.settings.pickApp()
                    await addExcluded(picked)
                  }}
                >
                  Выбрать .app…
                </button>
              </div>
            </div>

            {!bundle.encryptionAvailable && (
              <div className="notice err">
                Шифрование Keychain недоступно — ключи API не будут сохранены.
              </div>
            )}
          </section>
        )}

        <div className="footer">
          {banner ? (
            <span className={`banner ${banner.kind}`}>{banner.text}</span>
          ) : (
            <ApplyStatus state={applyState} holdReason={holdReason} />
          )}
          <div className="spacer" />
          <button onClick={() => void closeWindow()}>Закрыть</button>
        </div>
      </main>
    </div>
  )
}

/**
 * The one line that replaces the save button.
 *
 * With nothing to save it says nothing: a footer that permanently announces
 * "Применено" trains people to stop reading it, and the whole point of removing
 * the button is that the state has to be believable without being checked.
 */
function ApplyStatus(props: { state: ApplyState; holdReason: string | null }) {
  if (props.state === 'idle') return null
  const bad = props.state === 'error' || props.state === 'held'
  const text =
    props.state === 'pending'
      ? 'Применяю…'
      : props.state === 'saving'
        ? 'Сохраняю…'
        : props.state === 'saved'
          ? 'Применено'
          : props.state === 'held'
            ? (props.holdReason ?? 'Изменения не применены')
            : 'Не применено — попробуйте ещё раз'
  return (
    <span className={`banner ${bad ? 'err' : 'ok'}`} title={props.holdReason ?? undefined}>
      {text}
    </span>
  )
}

function PermissionRow(props: {
  title: string
  description: string
  granted: boolean
  onRequest(): Promise<void>
  onOpen(): void
}) {
  return (
    <div className="permission">
      <div>
        <div className="permission-title">
          {props.title} {props.granted ? <span className="ok">✓</span> : <span className="warn">—</span>}
        </div>
        <div className="hint">{props.description}</div>
      </div>
      <div className="permission-actions">
        {!props.granted && (
          <button className="primary" onClick={() => void props.onRequest()}>
            Запросить
          </button>
        )}
        <button onClick={props.onOpen}>Системные настройки</button>
      </div>
    </div>
  )
}

function QuickActionsEditor(props: {
  actions: QuickAction[]
  onChange(actions: QuickAction[]): void
}) {
  const update = (index: number, changes: Partial<QuickAction>): void => {
    props.onChange(props.actions.map((action, i) => (i === index ? { ...action, ...changes } : action)))
  }

  return (
    <div className="quick-actions">
      {props.actions.map((action, index) => (
        <div key={action.id} className="quick-action">
          <input
            className="qa-label"
            value={action.label}
            placeholder="Название"
            onChange={(event) => update(index, { label: event.target.value })}
          />
          <select
            className="qa-mode"
            value={action.mode}
            onChange={(event) =>
              update(index, { mode: event.target.value === 'analyze' ? 'analyze' : 'insert' })
            }
          >
            <option value="insert">вставка</option>
            <option value="analyze">анализ</option>
          </select>
          <textarea
            className="qa-prompt"
            rows={2}
            value={action.prompt}
            placeholder="Промпт"
            onChange={(event) => update(index, { prompt: event.target.value })}
          />
          <button
            className="ghost"
            title="Удалить"
            onClick={() => props.onChange(props.actions.filter((_, i) => i !== index))}
          >
            ✕
          </button>
        </div>
      ))}
      <button
        onClick={() =>
          props.onChange([
            ...props.actions,
            { id: `custom-${Date.now().toString(36)}`, label: 'Новое действие', prompt: '', mode: 'insert' }
          ])
        }
      >
        + Добавить действие
      </button>
    </div>
  )
}