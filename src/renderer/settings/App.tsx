/**
 * Settings window (ТЗ §7). Four sections: провайдер и ключи, голос, агент,
 * исключения и права. The hotkey and launch-at-login controls live in the
 * sidebar: they are two values, and a tab for two values is a tab nobody opens.
 *
 * There is no «Сохранить»: every field is written as it is edited. The button was
 * the reason a ticked checkbox could sit in a draft while the rest of the app
 * behaved as if it had never been ticked — which is exactly how "я же включил, а
 * он всё равно не нажимает" happened. What replaces it is not a promise but a
 * state line in the footer, and the two guards below: a write is held while a
 * field is mid-edit, and a window close waits for the last write to land.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AppSettings, KeyStatus, PermissionState, ProviderId } from '@shared/types'
import { PROVIDERS } from '@shared/defaults'
import type { AppPickResult, RunningAppInfo, SettingsBundle } from '@shared/api'
import { WindowBrand } from '../styles/WindowBrand'
import { HotkeyField } from './HotkeyField'
import {
  hasUnsaved,
  holdReasonFor,
  invalidBaseUrlProviders,
  writableSettings
} from './applyGate'
import { ApplyStatus, type ApplyState } from './ApplyStatus'
import { AgentTab } from './AgentTab'
import { VoiceTab } from './VoiceTab'
import { Toggle } from './Row'
import { ProviderSection } from './sections/ProviderSection'
import { PrivacySection } from './sections/PrivacySection'

type Tab = 'provider' | 'voice' | 'agent' | 'privacy'

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'provider', label: 'Модель' },
  { id: 'voice', label: 'Звук и голос' },
  { id: 'agent', label: 'Агент' },
  { id: 'privacy', label: 'Приватность' }
]

/** The heading above each pane: what it is, in one line, without repeating the rows. */
const PANE: Record<Tab, { title: string; subtitle: string }> = {
  provider: {
    title: 'Модель',
    subtitle: 'Кто отвечает на вопрос и что именно он получает на вход.'
  },
  voice: {
    title: 'Звук и голос',
    subtitle: 'Настрой голосовой ввод и выбери, что Deskhand произносит вслух.'
  },
  agent: {
    title: 'Агент',
    subtitle: 'Что ассистент может делать сам, а где останавливается и спрашивает.'
  },
  privacy: {
    title: 'Приватность',
    subtitle: 'Разрешения macOS, приложения-исключения и что хранится на диске.'
  }
}

/**
 * A 16 px line icon per pane.
 *
 * Drawn rather than pulled from a font: a stray glyph from a system font renders
 * at a different weight on every macOS version, and these sit next to 13 px text
 * where the difference is visible.
 */
function NavIcon({ tab }: { tab: Tab }) {
  const common = {
    width: 16,
    height: 16,
    viewBox: '0 0 16 16',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.4,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true
  }
  if (tab === 'provider') {
    return (
      <svg {...common}>
        <path d="M8 1.9 9.6 6.4 14 8l-4.4 1.6L8 14.1 6.4 9.6 2 8l4.4-1.6Z" />
      </svg>
    )
  }
  if (tab === 'voice') {
    return (
      <svg {...common}>
        <rect x="6" y="1.8" width="4" height="7" rx="2" />
        <path d="M3.6 7.4a4.4 4.4 0 0 0 8.8 0M8 11.8v2.4" />
      </svg>
    )
  }
  if (tab === 'agent') {
    return (
      <svg {...common}>
        <path d="M3.2 2.4v9.2l2.5-2.4 1.7 3.4 1.9-.9-1.7-3.3 3.4-.2Z" />
      </svg>
    )
  }
  return (
    <svg {...common}>
      <path d="M8 1.9 13 3.9v4.2c0 3-2.1 5-5 6-2.9-1-5-3-5-6V3.9Z" />
      <path d="m5.9 7.8 1.5 1.5 2.8-3" />
    </svg>
  )
}

/** How long a footer message stays up before the apply status comes back. */
const BANNER_WRITE_ERROR_MS = 2600
const BANNER_KEY_SAVE_MS = 3600
const BANNER_KEY_REMOVED_MS = 2200

/** Quiet time after the last edit before the draft is written. */
const AUTOSAVE_DEBOUNCE_MS = 450

/** A temporary message in the footer, replacing the apply status while it shows. */
interface Notice {
  kind: 'ok' | 'err'
  text: string
}

export function App() {
  const [bundle, setBundle] = useState<SettingsBundle | null>(null)
  const [draft, setDraft] = useState<AppSettings | null>(null)
  const [tab, setTab] = useState<Tab>('provider')
  const [notice, setNotice] = useState<Notice | null>(null)
  const [applyState, setApplyState] = useState<ApplyState>('idle')
  /**
   * The banner's own timer, so a newer notice is not cleared by an older one.
   *
   * Each banner sets its own expiry. Without a shared handle, a key-test result
   * that appears right after a write error inherits the error's timer and
   * disappears early — and a banner whose timer outlives the window fires into
   * an unmounted component.
   */
  const noticeTimerRef = useRef<number | null>(null)

  const showNotice = useCallback((next: Notice | null, clearAfterMs?: number) => {
    if (noticeTimerRef.current !== null) window.clearTimeout(noticeTimerRef.current)
    noticeTimerRef.current = null
    setNotice(next)
    if (!next || clearAfterMs === undefined) return
    noticeTimerRef.current = window.setTimeout(() => {
      noticeTimerRef.current = null
      setNotice(null)
    }, clearAfterMs)
  }, [])

  useEffect(
    () => () => {
      if (noticeTimerRef.current !== null) window.clearTimeout(noticeTimerRef.current)
    },
    []
  )

  const [keyInput, setKeyInput] = useState('')
  const [apps, setApps] = useState<RunningAppInfo[]>([])
  const [hotkeyMessage, setHotkeyMessage] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  /**
   * The scrolling pane, so switching tabs starts at the top.
   *
   * All four panes share one scroll container, so without this a glance at the
   * long «Звук и голос» pane leaves «Агент» scrolled to its second card — the new pane
   * opens in the middle of itself, which reads as a missing heading.
   */
  const scrollRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    scrollRef.current?.scrollTo(0, 0)
  }, [tab])

  useEffect(() => {
    // A rejected `load()` used to leave the window spinning on "Загрузка…"
    // forever, which looks like an empty settings window.
    void window.deskhand.settings
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
    void window.deskhand.settings
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

  const invalidBaseUrls = useMemo(
    () => (draft ? invalidBaseUrlProviders(draft) : []),
    [draft]
  )

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
   * rewrite the same settings on every `AUTOSAVE_DEBOUNCE_MS` tick for as long as
   * it stayed open.
   */
  const writtenRef = useRef<string | null>(null)

  /**
   * The snapshot a failed write was for, so it is not retried in a loop.
   *
   * Without this, a write that throws leaves the draft different from the bundle,
   * the effect sees work to do, waits `AUTOSAVE_DEBOUNCE_MS`, fails again — forever,
   * on every tick, for as long as the window is open. One failure is reported; the
   * next attempt happens when the user changes something, presses ⌘S or closes.
   */
  const failedRef = useRef<string | null>(null)

  /**
   * Lines the draft up with what the store actually kept.
   *
   * The store may normalise a value, and may refuse the hotkey outright; the
   * draft has to follow either, or the window keeps writing a snapshot the other
   * side never accepted. Returns whether the hotkey was the thing that did not
   * land.
   */
  const reconcileSavedBundle = useCallback((saved: SettingsBundle, written: string): boolean => {
    setBundle(saved)
    writtenRef.current = written
    failedRef.current = null
    const hotkeyRejected = Boolean(saved.hotkeyError)
    setDraft((current) => {
      if (!current) return current
      // A rejected hotkey comes back with the previous binding restored, and the
      // draft has to follow it: keeping the rejected combination would leave the
      // window retrying a write the system refuses, forever.
      if (hotkeyRejected) return { ...current, hotkey: saved.settings.hotkey }
      return JSON.stringify(current) === written ? saved.settings : current
    })
    return hotkeyRejected
  }, [])

  /** Says the hotkey did not land, and clears the snapshot so a retry can happen. */
  const reportHotkeyRejected = useCallback(() => {
    // The rejected binding is the one thing that did not land, so the write
    // snapshot must not be remembered: the draft is about to be dragged back to
    // the stored hotkey, and treating the refused combination as "already
    // applied" would hide a retry that can never succeed.
    writtenRef.current = null
    setHotkeyMessage('Комбинация занята — оставлена прежняя.')
    setApplyState('error')
    showNotice({ kind: 'err', text: 'Не удалось назначить горячую клавишу.' }, BANNER_WRITE_ERROR_MS)
  }, [showNotice])

  /**
   * Writes one snapshot of the draft.
   *
   * `snapshot` is passed in rather than read from state: a write is triggered by
   * a timer, and the draft at the moment the timer fires may already be newer
   * than the change it was scheduled for. The comparison after the round trip is
   * what keeps a slow disk from clobbering keys the user has typed since.
   */
  const flush = useCallback(
    async (snapshot: AppSettings): Promise<boolean> => {
      const written = JSON.stringify(snapshot)
      setApplyState('saving')
      try {
        const saved = await window.deskhand.settings.save(snapshot)
        if (reconcileSavedBundle(saved, written)) {
          reportHotkeyRejected()
          return false
        }
        setHotkeyMessage(null)
        setApplyState('saved')
        return true
      } catch {
        // Nothing reached the disk, so a later change must be allowed to try again —
        // but this exact snapshot must not, or the timer would retry it every
        // `AUTOSAVE_DEBOUNCE_MS` for as long as the window stayed open.
        writtenRef.current = null
        failedRef.current = written
        setApplyState('error')
        showNotice({ kind: 'err', text: 'Не удалось сохранить настройки.' }, BANNER_WRITE_ERROR_MS)
        return false
      }
    },
    [reconcileSavedBundle, reportHotkeyRejected, showNotice]
  )

  /**
   * Applies the draft as it is edited.
   *
   * `AUTOSAVE_DEBOUNCE_MS` of quiet: long enough that a typed model name is not
   * written letter by letter, short enough that a checkbox feels like it did
   * something. The timer is cleared on every new keystroke by the effect's own
   * cleanup.
   */
  useEffect(() => {
    if (!draft || !bundle) return
    const current = JSON.stringify(draft)
    if (!hasUnsaved(draft, bundle, writtenRef.current)) {
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
    }, AUTOSAVE_DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [draft, bundle, holdReason, flush])

  /**
   * Tells the main process that a write is still coming.
   *
   * ⌘W is how a window gets closed, and it lands inside `AUTOSAVE_DEBOUNCE_MS`
   * between the last keystroke and the write. Without this the window would be
   * destroyed with the edit still in React state — the exact bug the missing save
   * button was supposed to make impossible, just moved into a smaller window.
   */
  useEffect(() => {
    window.deskhand.settings.hold(applyState === 'pending' || applyState === 'saving')
  }, [applyState])

  /** Whether the draft holds anything that is not on disk yet. */
  const unsaved = useCallback(
    (value: AppSettings): boolean => hasUnsaved(value, bundle, writtenRef.current),
    [bundle]
  )

  /**
   * The draft as it can actually be written, for the explicit paths (⌘S, closing).
   *
   * The rules are in `applyGate.ts`, next to the ones that decide when a write is
   * held at all: the two used to be copies of each other's arithmetic, and a
   * disagreement between them is a quiet write loop rather than a visible error.
   */
  const writable = useCallback(
    (value: AppSettings): AppSettings => writableSettings(value, bundle, invalidBaseUrls),
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
    window.deskhand.settings.close()
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
    if (!draft || !keyInput.trim()) return false
    try {
      const next = await window.deskhand.settings.setKey(draft.provider, keyInput)
      setBundle(next)
      setKeyInput('')
      showNotice({ kind: 'ok', text: 'Ключ сохранён.' }, BANNER_KEY_SAVE_MS)
      return true
    } catch {
      showNotice({ kind: 'err', text: 'Не удалось сохранить ключ.' }, BANNER_KEY_SAVE_MS)
      return false
    }
  }, [draft, keyInput, showNotice])

  const removeKey = useCallback(async () => {
    if (!draft) return
    try {
      const next = await window.deskhand.settings.deleteKey(draft.provider)
      setBundle(next)
      showNotice({ kind: 'ok', text: 'Ключ удалён' }, BANNER_KEY_REMOVED_MS)
    } catch {
      showNotice({ kind: 'err', text: 'Не удалось удалить ключ.' }, BANNER_KEY_SAVE_MS)
    }
  }, [draft, showNotice])

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

  return (
    <div className="shell">
      <aside className="sidebar">
        <WindowBrand subtitle="Настройки" />
        <nav className="sidebar-nav" aria-label="Разделы настроек">
          {TABS.map((item) => (
            <button
              key={item.id}
              className={`nav ${tab === item.id ? 'active' : ''}`}
              aria-current={tab === item.id ? 'page' : undefined}
              onClick={() => setTab(item.id)}
            >
              <NavIcon tab={item.id} />
              {item.label}
            </button>
          ))}
        </nav>
        <div className="sidebar-foot">
          <div className="side-key">
            <div className="sidebar-label">Карточка</div>
            <HotkeyField
              value={draft.hotkey}
              onChange={(accelerator) => {
                setHotkeyMessage(null)
                patch({ hotkey: accelerator })
              }}
            />
            {hotkeyMessage && <div className="hint err">{hotkeyMessage}</div>}
          </div>

          <div className="side-toggle">
            <span>Запускать при входе</span>
            <Toggle
              checked={draft.launchAtLogin}
              label="Запускать при входе в систему"
              onChange={(launchAtLogin) => patch({ launchAtLogin })}
            />
          </div>
        </div>
      </aside>

      <main className="content">
        <header className="pane-head">
          <div className="pane-heading">
            <span className="pane-icon"><NavIcon tab={tab} /></span>
            <div>
              <h1>{PANE[tab].title}</h1>
              <p className="pane-sub">{PANE[tab].subtitle}</p>
            </div>
          </div>
        </header>

        <div className="settings-scroll" ref={scrollRef}>
          <div hidden={tab !== 'provider'}>
            <ProviderSection
              draft={draft}
              patch={patch}
              providerKeys={providerKeys}
              invalidBaseUrls={invalidBaseUrls}
              keyInput={keyInput}
              onKeyInput={setKeyInput}
              onSaveKey={saveKey}
              onRemoveKey={removeKey}
            />
          </div>

          {tab === 'voice' && (
            <VoiceTab
              voice={draft.voice}
              microphoneGranted={bundle.permissions.microphone}
              onOpenMicrophoneSettings={() => setTab('privacy')}
              tts={draft.tts}
              savedVoice={bundle.settings.voice}
              savedTts={bundle.settings.tts}
              onVoiceChange={(changes) => setDraft((current) => current
                ? { ...current, voice: { ...current.voice, ...changes } }
                : current)}
              onTtsChange={(changes) => setDraft((current) => current
                ? { ...current, tts: { ...current.tts, ...changes } }
                : current)}
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
                // autosave would also get there, one debounce too late.
                const availability = await window.deskhand.agent.setEnabled(enabled)
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

          {tab === 'privacy' && (
            <PrivacySection
              draft={draft}
              patch={patch}
              permissions={permissions}
              encryptionAvailable={bundle.encryptionAvailable}
              apps={apps}
              setBundle={setBundle}
              onAddExcluded={(picked) => void addExcluded(picked)}
            />
          )}
        </div>

        <div className="footer">
          {notice ? (
            <span className={`banner ${notice.kind}`}>{notice.text}</span>
          ) : (
            <ApplyStatus state={applyState} holdReason={holdReason} />
          )}
          <div className="spacer" />
          <button className="ghost" onClick={() => void closeWindow()}>
            Закрыть
          </button>
        </div>
      </main>
    </div>
  )
}
