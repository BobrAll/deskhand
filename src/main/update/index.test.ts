import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { UpdateState } from '@shared/types'

/**
 * The update flow end to end, with the network and the filesystem mocked at the
 * module seams: `feed.ts` owns HTTP, `apply.ts` owns codesign/ditto/the swap.
 * What is under test is the state machine — who may act in which phase, what a
 * failure does to the state, and that nothing installs itself.
 */

const feed = vi.hoisted(() => ({
  fetchLatestRelease: vi.fn(),
  fetchText: vi.fn(),
  downloadToFile: vi.fn()
}))

const apply = vi.hoisted(() => ({
  fileSha256: vi.fn(),
  unpackZip: vi.fn(),
  verifyUpdateApp: vi.fn(),
  startSwap: vi.fn()
}))

vi.mock('./feed', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./feed')>()
  return {
    ...actual,
    fetchLatestRelease: feed.fetchLatestRelease,
    fetchText: feed.fetchText,
    downloadToFile: feed.downloadToFile
  }
})

vi.mock('./apply', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./apply')>()
  return {
    ...actual,
    fileSha256: apply.fileSha256,
    unpackZip: apply.unpackZip,
    verifyUpdateApp: apply.verifyUpdateApp,
    startSwap: apply.startSwap
  }
})

import { createUpdateController, type UpdateHost } from './index'

const RELEASE = {
  version: '0.2.0',
  zipUrl: 'https://example.test/Deskhand-universal.zip',
  shaUrl: 'https://example.test/Deskhand-universal.zip.sha256',
  sizeBytes: 155_189_248
}

const DIGEST = 'a'.repeat(64)

/** The controller's cache dir: real fs calls (`rm`, `mkdir`) run against it. */
let cacheRoot = ''

interface FakeHost extends UpdateHost {
  states: UpdateState[]
  notifications: Array<{ title: string; body: string; onClick: () => void }>
  woke: Array<() => void>
  refreshTray: ReturnType<typeof vi.fn>
  openSettings: ReturnType<typeof vi.fn>
  quit: ReturnType<typeof vi.fn>
}

/** Host fields a test may replace; the spies are always fakes of their own. */
type HostOverrides = Partial<Pick<UpdateHost, 'appVersion' | 'installedAppPath' | 'cacheDir'>>

function fakeHost(overrides: HostOverrides = {}): FakeHost {
  const host: FakeHost = {
    appVersion: () => '0.1.0',
    installedAppPath: () => '/Applications/Deskhand.app',
    cacheDir: () => cacheRoot,
    notify: (title, body, onClick) => host.notifications.push({ title, body, onClick }),
    broadcast: (state) => host.states.push(state),
    refreshTray: vi.fn(),
    openSettings: vi.fn(),
    onWake: (listener) => host.woke.push(listener),
    quit: vi.fn(),
    states: [],
    notifications: [],
    woke: [],
    ...overrides
  }
  return host
}

/** A download that reports one progress step and leaves the file in place. */
function stubDownload(): void {
  feed.downloadToFile.mockImplementation(async (_url: string, _dest: string, onProgress: (p: number) => void) => {
    onProgress(1)
  })
  feed.fetchText.mockResolvedValue(`${DIGEST}  Deskhand-universal.zip`)
  apply.fileSha256.mockResolvedValue(DIGEST)
  apply.unpackZip.mockResolvedValue(undefined)
  apply.verifyUpdateApp.mockResolvedValue(undefined)
}

beforeEach(() => {
  vi.clearAllMocks()
  cacheRoot = mkdtempSync(join(tmpdir(), 'deskhand-update-'))
  feed.fetchLatestRelease.mockResolvedValue(RELEASE)
  stubDownload()
})

afterEach(() => {
  vi.useRealTimers()
  rmSync(cacheRoot, { recursive: true, force: true })
})

describe('update check', () => {
  it('offers a newer version and announces it exactly once', async () => {
    const host = fakeHost()
    const update = createUpdateController(host)

    await update.check(true)
    expect(update.state().phase).toBe('available')
    expect(update.state().latest).toBe('0.2.0')
    expect(host.notifications).toHaveLength(1)
    expect(host.notifications[0].title).toContain('0.2.0')

    await update.check(true)
    expect(host.notifications).toHaveLength(1)
  })

  it('reports "up to date" when the feed has nothing newer', async () => {
    feed.fetchLatestRelease.mockResolvedValue({ ...RELEASE, version: '0.1.0' })
    const update = createUpdateController(fakeHost())

    await update.check(true)
    const state = update.state()
    expect(state.phase).toBe('idle')
    expect(state.upToDate).toBe(true)
    expect(state.latest).toBeNull()
  })

  it('fails silently on an automatic check', async () => {
    feed.fetchLatestRelease.mockRejectedValue(new Error('offline'))
    const update = createUpdateController(fakeHost())

    await update.check(false)
    const state = update.state()
    expect(state.phase).toBe('idle')
    expect(state.message).toBeNull()
  })

  it('shows an error only when the user asked for the check', async () => {
    feed.fetchLatestRelease.mockRejectedValue(new Error('offline'))
    const update = createUpdateController(fakeHost())

    await update.check(true)
    const state = update.state()
    expect(state.phase).toBe('error')
    expect(state.retry).toBe('check')
    expect(state.message).toContain('попробуй ещё раз')
  })

  it('broadcasts every transition', async () => {
    const host = fakeHost()
    const update = createUpdateController(host)

    await update.check(true)
    const phases = host.states.map((state) => state.phase)
    expect(phases).toEqual(['checking', 'available'])
  })
})

describe('update download', () => {
  async function available() {
    const host = fakeHost()
    const update = createUpdateController(host)
    await update.check(true)
    return { host, update }
  }

  it('verifies the checksum and the signature before reporting ready', async () => {
    const { update } = await available()

    await update.download()

    expect(update.state().phase).toBe('ready')
    expect(feed.downloadToFile).toHaveBeenCalledWith(
      RELEASE.zipUrl,
      join(cacheRoot, '0.2.0', 'Deskhand-universal.zip'),
      expect.any(Function)
    )
    expect(apply.unpackZip).toHaveBeenCalled()
    expect(apply.verifyUpdateApp).toHaveBeenCalledWith(
      join(cacheRoot, '0.2.0', 'unpacked', 'Deskhand.app'),
      '/Applications/Deskhand.app'
    )
  })

  it('refuses a zip whose checksum does not match', async () => {
    apply.fileSha256.mockResolvedValue('b'.repeat(64))
    const { update } = await available()

    await update.download()

    const state = update.state()
    expect(state.phase).toBe('error')
    expect(state.retry).toBe('download')
    expect(state.message).toContain('Контрольная сумма')
    expect(apply.unpackZip).not.toHaveBeenCalled()
  })

  it('refuses an update signed by another certificate', async () => {
    apply.verifyUpdateApp.mockRejectedValue(
      new Error('Сертификат обновления не совпадает с установленным приложением.')
    )
    const { update } = await available()

    await update.download()

    expect(update.state().phase).toBe('error')
    expect(update.state().message).toContain('Сертификат')
  })

  it('does nothing before a check found something', async () => {
    const update = createUpdateController(fakeHost())

    await update.download()

    expect(update.state().phase).toBe('idle')
    expect(feed.downloadToFile).not.toHaveBeenCalled()
  })

  it('replaces a raw tool error with one Russian sentence', async () => {
    feed.downloadToFile.mockRejectedValue(new Error('Command failed: curl -fL /Users/b/hidden/path'))
    const { update } = await available()

    await update.download()

    const state = update.state()
    expect(state.phase).toBe('error')
    expect(state.message).toBe('Не удалось скачать обновление. Проверь интернет и попробуй ещё раз.')
    expect(state.message).not.toContain('/Users')
  })
})

describe('update install', () => {
  it('spawns the swap and quits only from the ready phase', async () => {
    const host = fakeHost()
    const update = createUpdateController(host)
    await update.check(true)
    await update.download()

    update.install()

    expect(apply.startSwap).toHaveBeenCalledTimes(1)
    const script = apply.startSwap.mock.calls[0][0] as string
    expect(script).toContain(join(cacheRoot, '0.2.0', 'unpacked', 'Deskhand.app'))
    expect(script).toContain('/Applications/.Deskhand.app.old')
    expect(host.quit).toHaveBeenCalledTimes(1)
  })

  it('never swaps without a downloaded bundle', async () => {
    const host = fakeHost()
    const update = createUpdateController(host)
    await update.check(true)

    update.install()

    expect(apply.startSwap).not.toHaveBeenCalled()
    expect(host.quit).not.toHaveBeenCalled()
  })

  it('spawns one swap however many times install is clicked', async () => {
    const host = fakeHost()
    const update = createUpdateController(host)
    await update.check(true)
    await update.download()

    update.install()
    update.install()

    expect(apply.startSwap).toHaveBeenCalledTimes(1)
    expect(host.quit).toHaveBeenCalledTimes(1)
  })
})

describe('tray line', () => {
  it('appears when an update waits and disappears when it does not', async () => {
    const host = fakeHost()
    const update = createUpdateController(host)
    expect(update.trayLine()).toBeNull()

    await update.check(true)
    const line = update.trayLine()
    expect(line?.label).toContain('0.2.0')
    line?.onClick()
    expect(host.openSettings).toHaveBeenCalledTimes(1)

    await update.download()
    const ready = update.trayLine()
    expect(ready?.label).toContain('Перезапустить')
    ready?.onClick()
    expect(host.quit).toHaveBeenCalledTimes(1)
  })
})

describe('schedule', () => {
  it('checks after the startup delay and on wake past the gap', async () => {
    vi.useFakeTimers()
    const host = fakeHost()
    const update = createUpdateController(host)
    update.schedule()

    await vi.advanceTimersByTimeAsync(10_000)
    expect(feed.fetchLatestRelease).toHaveBeenCalledTimes(1)

    // A wake right after a check does not repeat it.
    host.woke[0]()
    await vi.advanceTimersByTimeAsync(0)
    expect(feed.fetchLatestRelease).toHaveBeenCalledTimes(1)

    // A wake more than an hour later does.
    await vi.advanceTimersByTimeAsync(61 * 60_000)
    host.woke[0]()
    await vi.advanceTimersByTimeAsync(0)
    expect(feed.fetchLatestRelease).toHaveBeenCalledTimes(2)
  })
})

describe('an unpackaged build', () => {
  it('checks and downloads for real but refuses to swap without a bundle', async () => {
    const host = fakeHost({ installedAppPath: () => null })
    const update = createUpdateController(host)

    await update.check(true)
    expect(feed.fetchLatestRelease).toHaveBeenCalledTimes(1)
    expect(update.state().phase).toBe('available')

    await update.download()
    expect(update.state().phase).toBe('ready')

    update.install()
    expect(apply.startSwap).not.toHaveBeenCalled()
    expect(host.quit).not.toHaveBeenCalled()
    expect(update.state().phase).toBe('error')
    expect(update.state().message).toContain('собранном приложении')
  })
})
