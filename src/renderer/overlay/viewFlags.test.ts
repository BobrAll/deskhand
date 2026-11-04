/**
 * The card's flags, without a card.
 *
 * These expressions were inline in the middle of a 1300-line render, where the
 * only way to check them was to open the overlay and look. The cases below are the
 * ones that actually differ on screen, and each one is here because getting it
 * wrong is invisible rather than loud.
 */

import { describe, expect, it } from 'vitest'
import type { OverlayState } from '@shared/types'
import { deriveView, type ViewState } from './viewFlags'

/** The session as the card usually gets it: mode off, no warnings, not excluded. */
function session(overrides: Partial<OverlayState> = {}): OverlayState {
  return {
    sessionId: 's1',
    context: {
      activeApp: { name: 'Safari', bundleId: 'com.apple.Safari' },
      selection: null,
      screenshot: null,
      screenshotPending: false,
      excluded: false,
      warnings: [],
      collectedMs: 40
    },
    flags: { includeSelection: false, includeScreenshot: false },
    defaults: { includeSelection: false, includeScreenshot: false },
    quickActions: [],
    setupNotice: null,
    warnings: [],
    agent: { enabled: false, ready: false, reason: null },
    ...overrides
  } as OverlayState
}

function view(overrides: Partial<ViewState> = {}): ViewState {
  return {
    session: session(),
    expanded: false,
    hasAnswer: false,
    busy: false,
    failed: false,
    last: null,
    ...overrides
  }
}

describe('deriveView: before the session lands', () => {
  it('is not blocked and offers nothing', () => {
    const flags = deriveView(view({ session: null }))

    expect(flags.blocked).toBe(false)
    expect(flags.showMeta).toBe(false)
    expect(flags.canPaste).toBe(false)
    expect(flags.agentOff).toBe(false)
    expect(flags.agentBlocked).toBe(false)
    expect(flags.actionAsk).toBe(false)
    expect(flags.hint).toBeNull()
    expect(flags.alert).toBe(false)
  })
})

describe('deriveView: the exclusion list', () => {
  it('blocks the card and raises the alert even when folded', () => {
    const flags = deriveView(view({ session: session({ context: { ...session().context, excluded: true } }) }))

    expect(flags.blocked).toBe(true)
    expect(flags.alert).toBe(true)
  })
})

describe('deriveView: the drawer', () => {
  it('opens on the chevron while the card is empty', () => {
    expect(deriveView(view({ expanded: true })).showMeta).toBe(true)
  })

  it('stays shut once there is an answer to read', () => {
    expect(deriveView(view({ expanded: true, hasAnswer: true })).showMeta).toBe(false)
  })

  it('stays shut over a failure, which has its own line', () => {
    expect(deriveView(view({ expanded: true, failed: true })).showMeta).toBe(false)
  })
})

describe('deriveView: pasting', () => {
  it('offers paste only for a finished answer', () => {
    expect(deriveView(view({ hasAnswer: true })).canPaste).toBe(true)
    expect(deriveView(view({ hasAnswer: false })).canPaste).toBe(false)
  })

  it('does not offer paste while the answer is still being written', () => {
    expect(deriveView(view({ hasAnswer: true, busy: true })).canPaste).toBe(false)
  })
})

describe('deriveView: mouse control, off and blocked', () => {
  it('reads "off" when the user has not enabled it', () => {
    const flags = deriveView(view({ session: session({ agent: { enabled: false, ready: false, reason: null } }) }))

    expect(flags.agentOff).toBe(true)
    expect(flags.agentBlocked).toBe(false)
  })

  it('reads "blocked" when it is enabled but cannot run', () => {
    const flags = deriveView(
      view({
        session: session({ agent: { enabled: true, ready: false, reason: 'Нет доступа к универсальному доступу' } })
      })
    )

    expect(flags.agentOff).toBe(false)
    expect(flags.agentBlocked).toBe(true)
    // The reason is the hint: the card explains instead of just refusing.
    expect(flags.hint).toBe('Нет доступа к универсальному доступу')
  })

  it('is neither when it is on and ready', () => {
    const flags = deriveView(view({ session: session({ agent: { enabled: true, ready: true, reason: null } }) }))

    expect(flags.agentOff).toBe(false)
    expect(flags.agentBlocked).toBe(false)
    expect(flags.hint).toBeNull()
  })

  it('does not let a stale reason leak out of a ready agent', () => {
    // `reason` is set even when `ready` is true in the availability the runner
    // builds; the card must not print it over a working agent.
    const flags = deriveView(
      view({ session: session({ agent: { enabled: true, ready: true, reason: 'устаревшая причина' } }) })
    )

    expect(flags.hint).toBeNull()
  })
})

describe('deriveView: an action request with the mode off', () => {
  it('notices a prompt phrased as an action', () => {
    expect(deriveView(view({ last: { prompt: 'запусти видео', refine: null } })).actionAsk).toBe(true)
  })

  it('does not treat a rewrite as one', () => {
    // «Короче» over an answer that happens to read like an instruction is still a
    // rewrite: the user is editing text, not asking for the screen to be touched.
    expect(deriveView(view({ last: { prompt: 'запусти видео', refine: 'shorter' } })).actionAsk).toBe(false)
  })

  it('is false before anything has been asked', () => {
    expect(deriveView(view({ last: null })).actionAsk).toBe(false)
  })
})

describe('deriveView: the hint and the alert', () => {
  it('takes the first warning and skips the empty ones', () => {
    const flags = deriveView(view({ session: session({ warnings: ['', 'Скриншот недоступен'] }) }))

    expect(flags.hint).toBe('Скриншот недоступен')
  })

  it('prefers a warning over the agent reason', () => {
    const flags = deriveView(
      view({
        session: session({
          warnings: ['Скриншот недоступен'],
          agent: { enabled: true, ready: false, reason: 'Нет доступа' }
        })
      })
    )

    expect(flags.hint).toBe('Скриншот недоступен')
  })

  it('raises the alert for a setup notice, a failure or a hint', () => {
    const notice = session({ setupNotice: { kind: 'error', message: 'Нужен ключ' } })

    expect(deriveView(view({ session: notice })).alert).toBe(true)
    expect(deriveView(view({ failed: true })).alert).toBe(true)
    expect(deriveView(view({ session: session({ warnings: ['x'] }) })).alert).toBe(true)
  })

  it('stays quiet on an ordinary session', () => {
    expect(deriveView(view()).alert).toBe(false)
  })
})
