/**
 * The self-update flow.
 *
 * One state machine (`UpdateState` in `@shared/types`) driven by three user
 * gestures — check, download, install — and a schedule nobody has to think
 * about: a check shortly after launch, every six hours while the app runs, and
 * on wake from sleep when the last check is over an hour old. There is no fixed
 * wall-clock time, so a laptop that is offline or asleep at any "9:00" simply
 * checks later; a failed automatic check is silent and only a manual one
 * reports an error.
 *
 * Unpackaged builds run the same machine against the real feed: the update
 * simply cannot be installed without a bundle, and `install` says so.
 */

import { basename, dirname, join } from 'node:path'
import { accessSync, constants as fsConstants } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import type { UpdateState } from '@shared/types'
import {
  downloadToFile,
  fetchLatestRelease,
  fetchText,
  isNewerVersion,
  parseSha256,
  UPDATE_ZIP_NAME,
  type ReleaseInfo
} from './feed'
import { fileSha256, startSwap, swapScript, unpackZip, verifyUpdateApp } from './apply'

/** First check after launch: late enough to stay out of the startup path. */
const START_DELAY_MS = 10_000
const CHECK_INTERVAL_MS = 6 * 60 * 60_000
/** A wake only re-checks when the last attempt is older than this. */
const WAKE_MIN_GAP_MS = 60 * 60_000

/** The Electron-facing capabilities the controller needs, injected for tests. */
export interface UpdateHost {
  appVersion(): string
  /** The running `.app` bundle when packaged; null in dev. */
  installedAppPath(): string | null
  cacheDir(): string
  notify(title: string, body: string, onClick: () => void): void
  broadcast(state: UpdateState): void
  refreshTray(): void
  openSettings(): void
  /** powerMonitor 'resume', wired by the app entry point. */
  onWake(listener: () => void): void
  quit(): void
}

export interface UpdateController {
  state(): UpdateState
  check(manual: boolean): Promise<void>
  download(): Promise<void>
  install(): void
  /** Starts the launch timer, the interval and the wake listener. */
  schedule(): void
  /** The tray menu item while an update waits, or null. */
  trayLine(): { label: string; onClick: () => void } | null
}

/**
 * The sentence the panel shows after a failed download.
 *
 * Our own failures (`apply.ts`, the checksum) are already Russian and worth
 * showing; anything from a child process — `Command failed: codesign …`,
 * `HTTP 404`, a timeout — stays in the log and the user gets one plain line,
 * with no absolute paths leaked into the window.
 */
function downloadFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : ''
  if (/[а-яА-Я]/.test(message)) return message
  if (message) console.warn('[update] download failed:', message)
  return 'Не удалось скачать обновление. Проверь интернет и попробуй ещё раз.'
}

export function createUpdateController(host: UpdateHost): UpdateController {
  const current = host.appVersion()

  let state: UpdateState = {
    phase: 'idle',
    current,
    latest: null,
    progress: null,
    sizeBytes: null,
    message: null,
    retry: null,
    upToDate: false
  }

  /** The release the last successful check found; `download` uses its URLs. */
  let pendingRelease: ReleaseInfo | null = null
  /** The verified bundle waiting for `install`. */
  let stagedApp: string | null = null
  /** Versions already announced by a notification, so each nags once. */
  const announced = new Set<string>()
  let lastCheckAt = Date.now()
  /** One swap only: a second install click must not race the first script. */
  let swapping = false

  function set(patch: Partial<UpdateState>): void {
    const phaseMoved = patch.phase !== undefined && patch.phase !== state.phase
    const versionMoved = patch.latest !== undefined && patch.latest !== state.latest
    state = { ...state, ...patch }
    host.broadcast(state)
    // Progress ticks fire four times a second; only a phase or version change
    // alters the menu item, and rebuilding it on every tick is waste.
    if (phaseMoved || versionMoved) host.refreshTray()
  }

  async function runCheck(manual: boolean): Promise<void> {
    if (state.phase === 'downloading' || state.phase === 'ready' || state.phase === 'checking') return
    const before = state
    set({ phase: 'checking', message: null, retry: null })
    try {
      const release = await fetchLatestRelease()
      lastCheckAt = Date.now()
      if (!release) throw new Error('В релизе нет файла обновления.')
      if (!isNewerVersion(current, release.version)) {
        pendingRelease = null
        stagedApp = null
        set({ phase: 'idle', latest: null, sizeBytes: null, upToDate: true })
        return
      }
      pendingRelease = release
      stagedApp = null
      set({ phase: 'available', latest: release.version, sizeBytes: release.sizeBytes, upToDate: false })
      if (!announced.has(release.version)) {
        announced.add(release.version)
        host.notify(`Версия ${release.version} доступна`, 'Открой настройки, чтобы обновить.', () =>
          host.openSettings()
        )
      }
    } catch {
      lastCheckAt = Date.now()
      if (!manual) {
        set(before)
        return
      }
      set({
        phase: 'error',
        progress: null,
        message: 'Не удалось проверить обновления. Проверь интернет и попробуй ещё раз.',
        retry: 'check',
        latest: before.latest,
        sizeBytes: before.sizeBytes
      })
    }
  }

  async function runDownload(): Promise<void> {
    const fromAvailable = state.phase === 'available'
    const fromRetry = state.phase === 'error' && state.retry === 'download'
    if ((!fromAvailable && !fromRetry) || !pendingRelease) return
    const release = pendingRelease
    const version = release.version
    set({ phase: 'downloading', progress: 0, message: null, retry: null })
    try {
      const dir = join(host.cacheDir(), version)
      await rm(dir, { recursive: true, force: true })
      await mkdir(dir, { recursive: true })
      const zip = join(dir, UPDATE_ZIP_NAME)
      await downloadToFile(release.zipUrl, zip, (progress) => set({ progress }))
      const expected = parseSha256(await fetchText(release.shaUrl))
      if (!expected) throw new Error('В релизе нет контрольной суммы. Скачай обновление заново.')
      if ((await fileSha256(zip)) !== expected) {
        throw new Error('Контрольная сумма не совпала. Скачай обновление заново.')
      }
      const unpacked = join(dir, 'unpacked')
      await unpackZip(zip, unpacked)
      const appPath = join(unpacked, 'Deskhand.app')
      await verifyUpdateApp(appPath, host.installedAppPath())
      stagedApp = appPath
      set({ phase: 'ready', progress: null })
    } catch (error) {
      stagedApp = null
      set({
        phase: 'error',
        progress: null,
        message: downloadFailure(error),
        retry: 'download'
      })
    }
  }

  function runInstall(): void {
    if (swapping || state.phase !== 'ready' || !stagedApp) return
    const installed = host.installedAppPath()
    if (!installed) {
      set({
        phase: 'error',
        message: 'Обновление ставится только в собранном приложении.',
        retry: null
      })
      return
    }
    try {
      accessSync(dirname(installed), fsConstants.W_OK)
    } catch {
      set({
        phase: 'error',
        message: 'Нет прав на запись в папку приложения. Поставь обновление через install.sh.',
        retry: null
      })
      return
    }
    const paths = {
      stagedApp,
      installedApp: installed,
      backupApp: join(dirname(installed), `.${basename(installed)}.old`),
      logFile: join(dirname(stagedApp), 'swap.log')
    }
    swapping = true
    startSwap(swapScript(paths, process.pid))
    host.quit()
  }

  function schedule(): void {
    setTimeout(() => void runCheck(false), START_DELAY_MS)
    setInterval(() => void runCheck(false), CHECK_INTERVAL_MS)
    host.onWake(() => {
      if (Date.now() - lastCheckAt > WAKE_MIN_GAP_MS) void runCheck(false)
    })
  }

  function trayLine(): { label: string; onClick: () => void } | null {
    if (state.phase === 'ready' && state.latest) {
      return { label: `Перезапустить и обновить до ${state.latest}`, onClick: runInstall }
    }
    if (state.phase === 'available' && state.latest) {
      return { label: `Доступно обновление ${state.latest}`, onClick: () => host.openSettings() }
    }
    return null
  }

  return {
    state: () => state,
    check: runCheck,
    download: runDownload,
    install: runInstall,
    schedule,
    trayLine
  }
}
