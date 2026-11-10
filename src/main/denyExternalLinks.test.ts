import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { BrowserWindow } from 'electron'

/**
 * One handler for four windows. The only interesting axis is the scheme match:
 * three windows have always been case-sensitive, and `agent/cursor.ts` has always
 * had the `i` flag — a difference the extraction has to preserve, not smooth
 * over, because making `HTTPS://…` open in three windows that ignore it today is
 * a behaviour change.
 *
 * The window is a fake; no Electron is started.
 */

const env = vi.hoisted(() => ({
  opened: [] as string[],
  handler: null as ((details: { url: string }) => { action: string }) | null
}))

vi.mock('electron', () => ({
  shell: {
    openExternal: (url: string) => {
      env.opened.push(url)
      return Promise.resolve()
    }
  }
}))

const { denyExternalLinks } = await import('./denyExternalLinks')

function fakeWindow(): BrowserWindow {
  return {
    webContents: {
      setWindowOpenHandler: (handler: (details: { url: string }) => { action: string }) => {
        env.handler = handler
      }
    }
  } as unknown as BrowserWindow
}

/** Runs the installed handler and returns the URL it asked the shell to open. */
function open(url: string): { action: string; opened: string | null } {
  if (!env.handler) throw new Error('no handler installed')
  env.opened.length = 0
  const result = env.handler({ url })
  return { action: result.action, opened: env.opened[0] ?? null }
}

beforeEach(() => {
  env.opened.length = 0
  env.handler = null
})

describe('denyExternalLinks: the case-sensitive windows', () => {
  it('opens an http link in the browser', () => {
    denyExternalLinks(fakeWindow())
    expect(open('http://example.com')).toEqual({ action: 'deny', opened: 'http://example.com' })
  })

  it('opens an https link in the browser', () => {
    denyExternalLinks(fakeWindow())
    expect(open('https://example.com/path?q=1')).toEqual({
      action: 'deny',
      opened: 'https://example.com/path?q=1'
    })
  })

  it('denies every navigation, opened or not', () => {
    denyExternalLinks(fakeWindow())
    expect(open('file:///etc/passwd').action).toBe('deny')
    expect(open('javascript:alert(1)').action).toBe('deny')
  })

  it('ignores a scheme written in capitals — the pre-extraction behaviour', () => {
    denyExternalLinks(fakeWindow())
    expect(open('HTTPS://example.com')).toEqual({ action: 'deny', opened: null })
  })

  it('ignores a non-http scheme that starts with http', () => {
    denyExternalLinks(fakeWindow())
    expect(open('httpsx://example.com')).toEqual({ action: 'deny', opened: null })
  })
})

describe('denyExternalLinks: the case-insensitive window (agent cursor)', () => {
  it('opens a link whose scheme is in capitals', () => {
    denyExternalLinks(fakeWindow(), { matchSchemeCaseInsensitively: true })
    expect(open('HTTPS://example.com')).toEqual({
      action: 'deny',
      opened: 'HTTPS://example.com'
    })
  })

  it('still opens the ordinary spellings', () => {
    denyExternalLinks(fakeWindow(), { matchSchemeCaseInsensitively: true })
    expect(open('https://example.com').opened).toBe('https://example.com')
    expect(open('http://example.com').opened).toBe('http://example.com')
  })

  it('still denies everything else', () => {
    denyExternalLinks(fakeWindow(), { matchSchemeCaseInsensitively: true })
    expect(open('ftp://example.com').opened).toBeNull()
    expect(open('about:blank').action).toBe('deny')
  })
})
