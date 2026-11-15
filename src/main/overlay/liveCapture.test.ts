import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '@shared/defaults'
import type { ActiveAppInfo, AppSettings, ContextFlags, ContextSnapshot, ScreenshotInfo } from '@shared/types'
import { captureScreenshot } from '../context/screenshot'
import { helperFrontWindow, helperVisibleBundleIds } from '../native/helper'
import { getSettings } from '../settings/store'
import { createLiveCapture } from './liveCapture'

vi.mock('../native/helper', () => ({
  helperFrontApplication: vi.fn(),
  helperFrontWindow: vi.fn(),
  helperVisibleBundleIds: vi.fn(),
  helperWindow: vi.fn()
}))
vi.mock('../context/screenshot', () => ({ captureScreenshot: vi.fn() }))
vi.mock('../settings/store', () => ({ getSettings: vi.fn() }))
vi.mock('../layerWindow', () => ({ sameScreenRect: vi.fn(() => true) }))
vi.mock('../agent/trace', () => ({
  timed: (_event: string, work: () => Promise<unknown>) => work(),
  trace: vi.fn(),
  traceEnd: () => () => undefined
}))

const PASSWORDS: ActiveAppInfo = {
  bundleId: 'com.apple.Passwords',
  name: 'Passwords',
  pid: 99,
  windowTitle: 'Passwords',
  windowId: 11,
  bounds: { x: 100, y: 100, width: 640, height: 480 }
}

interface TestSession {
  id: string
  target: ActiveAppInfo | null
  snapshot: Pick<ContextSnapshot, 'screenshot' | 'screenshotPending'>
  flags: Pick<ContextFlags, 'includeScreenshot'>
  abort: AbortController | null
}

const oldShot = (): ScreenshotInfo => ({
  dataUrl: 'data:image/jpeg;base64,b2xk',
  width: 800,
  height: 600,
  bytes: 3,
  capturedAt: Date.now() - 5_000,
  area: { x: 0, y: 0, width: 800, height: 600 },
  fullScreen: true
})

function session(id: string, target: ActiveAppInfo | null): TestSession {
  return {
    id,
    target,
    snapshot: { screenshot: oldShot(), screenshotPending: true },
    flags: { includeScreenshot: true },
    abort: null
  }
}

function hostFor(current: () => TestSession | null) {
  return {
    window: () => null,
    isCurrent: (target: TestSession) => current() === target,
    publishContext: vi.fn(),
    hasAnnotations: vi.fn(() => false),
    onCaptureUnavailable: vi.fn()
  }
}

let settings: AppSettings

beforeEach(() => {
  settings = structuredClone(DEFAULT_SETTINGS)
  settings.excludedApps = [PASSWORDS.bundleId]
  vi.mocked(getSettings).mockReturnValue(settings)
  vi.mocked(helperFrontWindow).mockReset().mockResolvedValue(null)
  vi.mocked(helperVisibleBundleIds).mockReset().mockResolvedValue([])
  vi.mocked(captureScreenshot).mockReset()
})

describe('a capture with nothing it may photograph', () => {
  it('clears the frame and the shapes for the session on screen', async () => {
    const target = session('s1', PASSWORDS)
    const host = hostFor(() => target)
    const live = createLiveCapture(host)

    await expect(live.ensureFreshScreenshot(target)).resolves.toBeNull()

    expect(target.snapshot.screenshot).toBeNull()
    expect(target.snapshot.screenshotPending).toBe(false)
    expect(host.publishContext).toHaveBeenCalledWith(target)
    expect(host.onCaptureUnavailable).toHaveBeenCalledOnce()
    expect(captureScreenshot).not.toHaveBeenCalled()
  })

  it('clears a stale session without discarding the current shapes', async () => {
    const stale = session('stale', PASSWORDS)
    const currentSession = session('current', null)
    let release!: () => void
    const frontRead = new Promise<null>((resolve) => {
      release = () => resolve(null)
    })
    vi.mocked(helperFrontWindow).mockReturnValue(frontRead)
    const host = hostFor(() => currentSession)
    const live = createLiveCapture(host)

    const capture = live.ensureFreshScreenshot(stale)
    release()
    await expect(capture).resolves.toBeNull()

    expect(stale.snapshot.screenshot).toBeNull()
    expect(stale.snapshot.screenshotPending).toBe(false)
    expect(host.publishContext).toHaveBeenCalledWith(stale)
    expect(host.onCaptureUnavailable).not.toHaveBeenCalled()
  })
})
