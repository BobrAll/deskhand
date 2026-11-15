import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Permission reads are a set of decisions, not a set of calls: what counts as
 * "granted", which source wins, and what a thrown Electron API means. All three
 * matter because the wrong answer either blocks the app behind a permission the
 * user already gave, or promises a feature that will fail on first use.
 *
 * `electron` and the helper bridge are mocked: no real TCC query, no prompt.
 */

const env = vi.hoisted(() => ({
  /** What `systemPreferences` reports, per API. */
  accessibility: false,
  screen: 'denied' as string,
  microphone: 'denied' as string,
  /** Make a specific API throw, as it does on older macOS. */
  throwAccessibility: false,
  throwScreen: false,
  throwMicrophone: false,
  /** Simulate the user accepting the Accessibility prompt. */
  grantOnPrompt: false,
  /** The helper fallback answer; `null` means "the helper said nothing". */
  helper: null as null | { accessibility: boolean; screenRecording: boolean },
  helperThrows: false,
  /** Calls, so the order of reads is visible. */
  calls: [] as string[],
  asked: 0,
  opened: [] as string[],
  captured: 0
}))

vi.mock('electron', () => ({
  shell: {
    openExternal: (url: string) => {
      env.opened.push(url)
    }
  },
  systemPreferences: {
    isTrustedAccessibilityClient: (prompt: boolean) => {
      env.calls.push(prompt ? 'accessibility:prompt' : 'accessibility:read')
      if (env.throwAccessibility) throw new Error('not available')
      // Asking is what makes macOS show the grant dialog; a user who accepts it
      // makes the very next read answer `true`, which is the sequence that test
      // is about.
      if (prompt && env.grantOnPrompt) env.accessibility = true
      return env.accessibility
    },
    getMediaAccessStatus: (kind: string) => {
      env.calls.push(`${kind}:read`)
      if (kind === 'screen' && env.throwScreen) throw new Error('no screen api')
      if (kind === 'microphone' && env.throwMicrophone) throw new Error('no mic api')
      return kind === 'screen' ? env.screen : env.microphone
    },
    askForMediaAccess: async () => {
      env.asked += 1
      return env.microphone === 'granted'
    }
  },
  desktopCapturer: {
    getSources: async () => {
      env.captured += 1
      return []
    }
  }
}))

vi.mock('./native/helper', () => ({
  helperPermissions: async (request: boolean) => {
    env.calls.push(request ? 'helper:request' : 'helper:read')
    if (env.helperThrows) throw new Error('helper missing')
    return env.helper
  }
}))

async function loadPermissions(): Promise<typeof import('./permissions')> {
  vi.resetModules()
  return import('./permissions')
}

beforeEach(() => {
  env.accessibility = false
  env.screen = 'denied'
  env.microphone = 'denied'
  env.throwAccessibility = false
  env.throwScreen = false
  env.throwMicrophone = false
  env.helper = null
  env.grantOnPrompt = false
  env.helperThrows = false
  env.calls.length = 0
  env.asked = 0
  env.opened.length = 0
  env.captured = 0
})

describe('readPermissions: which source wins', () => {
  it('takes all three answers from Electron when they are available', async () => {
    env.accessibility = true
    env.screen = 'granted'
    env.microphone = 'granted'
    const { readPermissions } = await loadPermissions()

    expect(await readPermissions()).toEqual({
      accessibility: true,
      screenRecording: true,
      microphone: true
    })
    // Accessibility was granted, so the helper is never asked: its answer is the
    // less reliable one and it costs a process spawn.
    expect(env.calls).not.toContain('helper:read')
  })

  it('only counts `granted`, not `unknown` or `denied`', async () => {
    env.screen = 'unknown'
    env.microphone = 'not-determined'
    const { readPermissions } = await loadPermissions()

    const state = await readPermissions()
    expect(state.screenRecording).toBe(false)
    expect(state.microphone).toBe(false)
  })

  it('falls back to the helper only when Electron cannot answer', async () => {
    env.throwAccessibility = true
    env.helper = { accessibility: true, screenRecording: true }
    const { readPermissions } = await loadPermissions()

    expect(await readPermissions()).toEqual({
      accessibility: true,
      screenRecording: false,
      microphone: false
    })
  })

  it('does not let the helper overrule an app that says it is not trusted', async () => {
    // The helper is a separate executable with its own TCC entry, so it can stay
    // trusted after the app's grant is revoked. Believing it is how the settings
    // window came to promise a grant while the agent refused to act.
    env.accessibility = false
    env.helper = { accessibility: true, screenRecording: true }
    const { readPermissions, accessibilityTrusted } = await loadPermissions()

    expect((await readPermissions()).accessibility).toBe(false)
    expect(accessibilityTrusted()).toBe(false)
  })

  it('agrees with the gate the agent uses', async () => {
    env.accessibility = true
    env.helper = { accessibility: false, screenRecording: false }
    const { readPermissions, accessibilityTrusted } = await loadPermissions()

    expect((await readPermissions()).accessibility).toBe(true)
    expect(accessibilityTrusted()).toBe(true)
  })

  it('keeps Accessibility false when the helper disagrees about nothing', async () => {
    env.accessibility = false
    env.helper = { accessibility: false, screenRecording: true }
    const { readPermissions } = await loadPermissions()

    expect((await readPermissions()).accessibility).toBe(false)
  })

  it('survives a helper that throws', async () => {
    env.helperThrows = true
    const { readPermissions } = await loadPermissions()

    expect((await readPermissions()).accessibility).toBe(false)
  })

  it('treats a thrown Electron API as "not granted" rather than crashing', async () => {
    env.throwAccessibility = true
    env.throwScreen = true
    env.throwMicrophone = true
    env.helper = null
    const { readPermissions } = await loadPermissions()

    expect(await readPermissions()).toEqual({
      accessibility: false,
      screenRecording: false,
      microphone: false
    })
  })

  it('reads Accessibility without prompting', async () => {
    const { readPermissions } = await loadPermissions()
    await readPermissions()
    expect(env.calls).toContain('accessibility:read')
    expect(env.calls).not.toContain('accessibility:prompt')
  })
})

describe('requestMicrophonePermission', () => {
  it('does not ask when the microphone is already granted', async () => {
    env.microphone = 'granted'
    const { requestMicrophonePermission } = await loadPermissions()

    expect(await requestMicrophonePermission()).toBe(true)
    expect(env.asked).toBe(0)
  })

  it('asks exactly once when it is not', async () => {
    env.microphone = 'denied'
    const { requestMicrophonePermission } = await loadPermissions()

    expect(await requestMicrophonePermission()).toBe(false)
    expect(env.asked).toBe(1)
  })

  it('is false when the API throws instead of prompting', async () => {
    env.throwMicrophone = true
    const { requestMicrophonePermission } = await loadPermissions()

    expect(await requestMicrophonePermission()).toBe(false)
    expect(env.asked).toBe(0)
  })
})

describe('requestPermissions: what it actually asks for', () => {
  it('requests screen recording without prompting for Accessibility', async () => {
    const { requestPermissions } = await loadPermissions()

    await requestPermissions('screenRecording')

    expect(env.captured).toBe(1)
    expect(env.calls).not.toContain('accessibility:prompt')
    expect(env.calls).not.toContain('helper:request')
    expect(env.asked).toBe(0)
  })

  it('requests Accessibility without touching the screen capturer', async () => {
    const { requestPermissions } = await loadPermissions()

    await requestPermissions('accessibility')

    expect(env.calls).toContain('accessibility:prompt')
    expect(env.calls).not.toContain('helper:request')
    expect(env.captured).toBe(0)
    expect(env.asked).toBe(0)
  })

  it('prompts for Accessibility once, touches the capturer, then re-reads', async () => {
    env.accessibility = true
    const { requestPermissions } = await loadPermissions()

    await requestPermissions()

    expect(env.calls).toContain('accessibility:prompt')
    // Screen Recording has no request API in Electron; touching the capturer is
    // what makes macOS show the prompt.
    expect(env.captured).toBe(1)
    expect(env.calls).toContain('helper:request')
  })

  it('skips the capturer when Screen Recording is already granted', async () => {
    env.screen = 'granted'
    const { requestPermissions } = await loadPermissions()

    await requestPermissions()
    expect(env.captured).toBe(0)
  })

  it('returns the state read after the prompts, not before them', async () => {
    env.accessibility = false
    env.grantOnPrompt = true
    const { requestPermissions } = await loadPermissions()

    expect((await requestPermissions()).accessibility).toBe(true)
  })

  it('does not fail when every request path throws', async () => {
    env.throwAccessibility = true
    env.throwScreen = true
    env.throwMicrophone = true
    env.helperThrows = true
    const { requestPermissions } = await loadPermissions()

    await expect(requestPermissions()).resolves.toEqual({
      accessibility: false,
      screenRecording: false,
      microphone: false
    })
  })
})

describe('openPermissionPane: which System Settings page', () => {
  it('opens the Accessibility pane', async () => {
    const { openPermissionPane } = await loadPermissions()
    openPermissionPane('accessibility')
    expect(env.opened).toEqual(['x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility'])
  })

  it('opens the Screen Recording pane', async () => {
    const { openPermissionPane } = await loadPermissions()
    openPermissionPane('screenRecording')
    expect(env.opened).toEqual(['x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'])
  })

  it('opens the Microphone pane, through the same path as `openMicrophonePane`', async () => {
    const { openPermissionPane, openMicrophonePane } = await loadPermissions()
    openPermissionPane('microphone')
    openMicrophonePane()
    expect(env.opened).toEqual([
      'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
      'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone'
    ])
  })
})
