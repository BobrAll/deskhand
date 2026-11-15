import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { BrowserWindow } from 'electron'

/**
 * One handler for four windows. The interesting axes are the scheme match (three
 * windows have always been case-sensitive, and `agent/cursor.ts` has always had
 * the `i` flag) and the two ways a page can leave the app: a new window, and a
 * navigation in place (a dragged link, an anchor without `target="_blank"`).
 *
 * The window is a fake; no Electron is started.
 */

const env = vi.hoisted(() => ({
  opened: [] as string[],
  handler: null as ((details: { url: string }) => { action: string }) | null,
  navigate: null as ((event: { preventDefault: () => void }, url: string) => void) | null
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
      },
      on: (event: string, handler: (event: { preventDefault: () => void }, url: string) => void) => {
        if (event === 'will-navigate') env.navigate = handler
      }
    }
  } as unknown as BrowserWindow
}

/** Runs the installed window-open handler and returns what it did. */
function open(url: string): { action: string; opened: string | null } {
  if (!env.handler) throw new Error('no handler installed')
  env.opened.length = 0
  const result = env.handler({ url })
  return { action: result.action, opened: env.opened[0] ?? null }
}

/** Runs the installed navigation guard for `url`; true when it was allowed. */
function navigate(url: string): { allowed: boolean; opened: string | null } {
  if (!env.navigate) throw new Error('no navigation guard installed')
  env.opened.length = 0
  let prevented = false
  env.navigate(
    {
      preventDefault: () => {
        prevented = true
      }
    },
    url
  )
  return { allowed: !prevented, opened: env.opened[0] ?? null }
}

beforeEach(() => {
  env.opened.length = 0
  env.handler = null
  env.navigate = null
})

afterEach(() => {
  vi.unstubAllEnvs()
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

describe('denyExternalLinks: navigation in place', () => {
  it('denies a link dragged onto the page and opens it in the browser', () => {
    denyExternalLinks(fakeWindow())

    expect(navigate('https://example.com/dropped')).toEqual({
      allowed: false,
      opened: 'https://example.com/dropped'
    })
  })

  it('denies a navigation to a non-web URL without opening anything', () => {
    denyExternalLinks(fakeWindow())

    expect(navigate('javascript:alert(1)')).toEqual({ allowed: false, opened: null })
  })

  it('lets the app load its own file pages', () => {
    denyExternalLinks(fakeWindow())

    const page = pathToFileURL(join(__dirname, '../renderer/settings/index.html')).href

    expect(navigate(page)).toEqual({ allowed: true, opened: null })
  })

  it('denies a local file that is not one of the app pages', () => {
    // A dragged `.html` is still a `file:` URL, and navigating to it would keep
    // the deskhand preload while showing a foreign page.
    denyExternalLinks(fakeWindow())

    const foreign = pathToFileURL(join(tmpdir(), 'dropped.html')).href

    expect(navigate(foreign)).toEqual({ allowed: false, opened: null })
  })

  it('denies a file that only looks like it lives next to the renderer', () => {
    denyExternalLinks(fakeWindow())

    const sibling = pathToFileURL(join(__dirname, '../renderer-evil/index.html')).href

    expect(navigate(sibling).allowed).toBe(false)
  })

  it('denies a renderer path that climbs out, including a percent-encoded one', () => {
    denyExternalLinks(fakeWindow())

    const renderer = pathToFileURL(join(__dirname, '../renderer')).href

    expect(navigate(`${renderer}/../preload/index.js`).allowed).toBe(false)
    expect(navigate(`${renderer}/%2e%2e/preload/index.js`).allowed).toBe(false)
  })

  it('lets the dev server load its own pages', () => {
    vi.stubEnv('ELECTRON_RENDERER_URL', 'http://localhost:5173')
    denyExternalLinks(fakeWindow())

    expect(navigate('http://localhost:5173/settings/index.html')).toEqual({
      allowed: true,
      opened: null
    })
  })

  it('denies a navigation to another host while the dev server is running', () => {
    vi.stubEnv('ELECTRON_RENDERER_URL', 'http://localhost:5173')
    denyExternalLinks(fakeWindow())

    expect(navigate('http://localhost:9999/settings/index.html').allowed).toBe(false)
  })
})
