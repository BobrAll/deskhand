/**
 * The one list four callers share.
 *
 * `resourcePath`, the helper, the whisper binaries and the agent binary all look
 * for a shipped file, and each used to carry its own copy of "packaged has
 * `resources/`, dev looks in the app and then in the working directory". The
 * copies had drifted; this pins the rule once, including where the extra
 * candidates go — a Homebrew binary or a Swift build must be looked at *before*
 * the working directory, or a stale checkout would win over a real install.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  existing: new Set<string>(),
  isPackaged: false,
  appPath: '/app',
  resourcesPath: '/resources'
}))

Object.defineProperty(process, 'resourcesPath', { value: '/resources', configurable: true })

vi.mock('electron', () => ({
  app: {
    get isPackaged() {
      return state.isPackaged
    },
    getAppPath: () => state.appPath
  }
}))

vi.mock('node:fs', () => ({
  existsSync: (path: string) => state.existing.has(path)
}))

import { resourceCandidates, resourcePath } from './paths'

beforeEach(() => {
  state.existing = new Set()
  state.isPackaged = false
})

describe('resourceCandidates: the shared order', () => {
  it('has exactly one place in a packaged app', () => {
    state.isPackaged = true
    expect(resourceCandidates('trayTemplate.png')).toEqual(['/resources/trayTemplate.png'])
  })

  it('looks in the app, then the working directory, in a checkout', () => {
    expect(resourceCandidates('deskhand-helper')).toEqual([
      '/app/resources/deskhand-helper',
      `${process.cwd()}/resources/deskhand-helper`
    ])
  })

  it('puts an extra candidate before the working directory', () => {
    expect(resourceCandidates('whisper-cli', ['/opt/homebrew/bin/whisper-cli'])).toEqual([
      '/app/resources/whisper-cli',
      '/opt/homebrew/bin/whisper-cli',
      `${process.cwd()}/resources/whisper-cli`
    ])
  })

  it('ignores extras in a packaged app, where only the bundle counts', () => {
    state.isPackaged = true
    expect(resourceCandidates('whisper-cli', ['/opt/homebrew/bin/whisper-cli'])).toEqual([
      '/resources/whisper-cli'
    ])
  })
})

describe('resourcePath: a path even when the file is absent', () => {
  it('returns the first existing candidate', () => {
    state.existing = new Set([`${process.cwd()}/resources/trayTemplate.png`])
    expect(resourcePath('trayTemplate.png')).toBe(`${process.cwd()}/resources/trayTemplate.png`)
  })

  it('falls back to the first candidate rather than null', () => {
    // The tray and the window images take a path and draw an empty image for a
    // file that is not there; a null would be a different contract.
    expect(resourcePath('trayTemplate.png')).toBe('/app/resources/trayTemplate.png')
  })
})
