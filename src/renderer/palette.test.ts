import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The palette: what every window actually resolves its CSS variables to, in the
 * light and the dark appearance.
 *
 * This is a safety net, not a style guide. The tokens live in `styles/base.css`
 * and each window's own sheet; the renderers are plain CSS with no build-time
 * indirection, so the only thing that can silently break a colour is an edit to a
 * literal — and the only way to notice is to read the resolved value. The
 * snapshot below is that reading: change a hue on purpose, update the snapshot;
 * change one by accident, and the diff says which window went a different way.
 *
 * Only the sheets a window loads are applied, in the order it loads them, and the
 * light block is read out of the `prefers-color-scheme: light` media query. No
 * browser is started: the cascade here is a variable map, and the map is what is
 * being pinned.
 */

const ROOT = resolve(__dirname, '..')

/** The sheets each window loads, in document order (HTML link, then entry import). */
const WINDOWS: Record<string, string[]> = {
  overlay: ['styles/base.css', 'overlay/overlay.css'],
  settings: ['styles/base.css', 'settings/settings.css'],
  onboarding: ['styles/base.css', 'onboarding/onboarding.css'],
  cursor: ['styles/base.css', 'cursor/cursor.css'],
  pointer: ['styles/base.css', 'pointer/pointer.css']
}

type Variables = Record<string, string>

function readSheet(relative: string): string {
  return readFileSync(resolve(ROOT, 'renderer', relative), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
}

/** The body of the `prefers-color-scheme: light` media query, if the sheet has one. */
function lightBlock(sheet: string): string {
  const match = /@media\s*\(prefers-color-scheme:\s*light\)\s*\{([\s\S]*)\n\}/.exec(sheet)
  return match ? match[1] : ''
}

/** Removes the light media query, so a dark read cannot see the light overrides. */
function withoutLightBlock(sheet: string): string {
  return sheet.replace(/@media\s*\(prefers-color-scheme:\s*light\)\s*\{[\s\S]*?\n\}/g, '')
}

/** `--name: value` pairs of one block body. */
function variablesIn(body: string): Variables {
  const out: Variables = {}
  for (const [, name, value] of body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
    out[name] = value.trim()
  }
  return out
}

/** Variables declared on `:root` in the sheet's base (dark) cascade. */
function rootVariables(sheet: string): Variables {
  const out: Variables = {}
  for (const [, selector, body] of withoutLightBlock(sheet).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (selector.trim() === ':root') Object.assign(out, variablesIn(body))
  }
  return out
}

/** Variables the light media query overrides. */
function lightVariables(sheet: string): Variables {
  const out: Variables = {}
  for (const [, selector, body] of lightBlock(sheet).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (selector.trim() === ':root') Object.assign(out, variablesIn(body))
  }
  return out
}

/** Resolves a window's variables for one appearance, in cascade order. */
function resolveWindow(window: string, appearance: 'dark' | 'light'): Variables {
  const resolved: Variables = {}
  for (const sheetName of WINDOWS[window]) {
    const sheet = readSheet(sheetName)
    Object.assign(resolved, rootVariables(sheet))
    if (appearance === 'light') Object.assign(resolved, lightVariables(sheet))
  }
  return resolved
}

/** Every window resolves the same base tokens, so the app has one palette. */
const BASE_TOKENS = [
  '--bg',
  '--bg-solid',
  '--surface',
  '--surface-strong',
  '--border',
  '--border-strong',
  '--text',
  '--text-dim',
  '--text-faint',
  '--accent',
  '--accent-strong',
  '--accent-soft',
  '--danger',
  '--warning',
  '--success',
  '--shadow',
  '--radius',
  '--radius-sm',
  '--glass-tint',
  '--glass-sheen',
  '--glass-edge'
]

describe('palette: the base tokens', () => {
  it('declares every base token in both appearances', () => {
    const dark = resolveWindow('overlay', 'dark')
    const light = resolveWindow('overlay', 'light')
    for (const token of BASE_TOKENS) {
      expect(dark[token], `dark ${token}`).toBeTruthy()
      expect(light[token], `light ${token}`).toBeTruthy()
    }
  })

  it('gives every window the same base palette', () => {
    const pick = (window: string, appearance: 'dark' | 'light'): Variables => {
      const resolved = resolveWindow(window, appearance)
      return Object.fromEntries(BASE_TOKENS.map((token) => [token, resolved[token]]))
    }
    for (const window of Object.keys(WINDOWS)) {
      expect(pick(window, 'dark'), window).toEqual(pick('overlay', 'dark'))
      expect(pick(window, 'light'), window).toEqual(pick('overlay', 'light'))
    }
  })

  it('inverts the two appearances: no colour token equals its dark twin', () => {
    const dark = resolveWindow('overlay', 'dark')
    const light = resolveWindow('overlay', 'light')
    for (const token of BASE_TOKENS) {
      // The radii are appearance-independent on purpose; only colours move.
      if (token.startsWith('--radius')) continue
      expect(light[token], token).not.toBe(dark[token])
    }
  })
})

describe('palette: per-window colours', () => {
  it('gives the overlay a panel that follows the appearance', () => {
    const dark = resolveWindow('overlay', 'dark')
    const light = resolveWindow('overlay', 'light')
    expect(dark['--panel']).toBe('rgba(21, 23, 29, 0.94)')
    expect(light['--panel']).toBe('rgba(249, 249, 251, 0.96)')
    expect(dark['--panel-drawing']).toBe('rgba(21, 23, 29, 0.40)')
    expect(light['--panel-drawing']).toBe('rgba(249, 249, 251, 0.42)')
  })

  it('keeps the cursor chrome identical in both appearances', () => {
    // The ring is glass over someone else's content rather than a surface to read
    // on, so it is deliberately not theme-dependent (see the comments in the sheet).
    for (const window of ['cursor']) {
      const dark = resolveWindow(window, 'dark')
      const light = resolveWindow(window, 'light')
      const own = Object.keys(dark).filter((name) => /^--cursor-/.test(name))
      expect(own.length, window).toBeGreaterThan(3)
      for (const name of own) {
        expect(light[name], `${window} ${name}`).toBe(dark[name])
      }
    }
  })

  it('keeps the drawing ink identical in both appearances', () => {
    // The layer paints over arbitrary content and relies on a white halo for
    // contrast; a per-appearance ink would break that.
    const ink = (appearance: 'dark' | 'light'): string | undefined => {
      const sheet = readSheet('pointer/pointer.css')
      const source = appearance === 'light' ? sheet : withoutLightBlock(sheet)
      return /--ink\s*:\s*([^;]+);/.exec(source)?.[1].trim()
    }
    expect(ink('dark')).toBe('#5b78ff')
    expect(ink('light')).toBe('#5b78ff')
  })

  it('matches the resolved palette snapshot, per window and appearance', () => {
    const snapshot: Record<string, Variables> = {}
    for (const window of Object.keys(WINDOWS)) {
      snapshot[`${window}/dark`] = resolveWindow(window, 'dark')
      snapshot[`${window}/light`] = resolveWindow(window, 'light')
    }
    expect(snapshot).toMatchSnapshot()
  })
})

describe('palette: no dangling references', () => {
  it('declares every variable a window uses', () => {
    // A `var(--token)` with no declaration is not a build error — it is an empty
    // value, so the property silently does nothing. The check is per window,
    // because a token declared only in the overlay's sheet is missing in settings.
    const missing: string[] = []
    for (const [window, sheets] of Object.entries(WINDOWS)) {
      const declared = new Set<string>()
      const used = new Set<string>()
      for (const sheetName of sheets) {
        const sheet = readSheet(sheetName)
        for (const [, name] of sheet.matchAll(/(--[a-z0-9-]+)\s*:/g)) declared.add(name)
        // `var(--x, fallback)` is safe when the token is missing; only a bare
        // `var(--x)` goes blank, so only that counts as a dangling use.
        for (const [, name] of sheet.matchAll(/var\(\s*(--[a-z0-9-]+)\s*\)/g)) used.add(name)
      }
      for (const name of used) {
        // Variables set from JS at runtime (the pointer's per-shape delay, the
        // cursor's coordinates) have no CSS declaration on purpose.
        if (['--delay', '--x', '--y'].includes(name)) continue
        if (!declared.has(name)) missing.push(`${window}: ${name}`)
      }
    }
    expect(missing).toEqual([])
  })
})
