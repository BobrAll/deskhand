import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

/**
 * The preload bridge is the only surface a renderer page can reach, and it is
 * typed by hand against `DeskhandApi`. TypeScript checks that the object
 * satisfies the interface, but it cannot notice the opposite drift: a method
 * added to `api.ts` and forgotten here is a page that crashes on a click, and
 * nothing else in the build complains.
 *
 * So both sides are read: the runtime object that is actually exposed, and the
 * interface declaration in `shared/api.ts`. Electron is mocked; nothing is
 * exposed to a real window.
 */

const exposed = vi.hoisted(() => ({
  api: null as Record<string, unknown> | null,
  ipcOn: [] as string[],
  ipcInvoke: [] as string[]
}))

vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: (key: string, api: Record<string, unknown>) => {
      expect(key).toBe('deskhand')
      exposed.api = api
    }
  },
  ipcRenderer: {
    on: (channel: string) => {
      exposed.ipcOn.push(channel)
    },
    removeListener: () => undefined,
    send: () => undefined,
    invoke: async (channel: string) => {
      exposed.ipcInvoke.push(channel)
      return null
    }
  }
}))

// The bridge registers itself on import; importing it here is the act of building it.
await import('../preload/index')

/** Every leaf path of an object of nested namespaces, e.g. `overlay.send`. */
function flattenMethods(node: Record<string, unknown>, prefix = ''): string[] {
  const out: string[] = []
  for (const [key, value] of Object.entries(node)) {
    const path = prefix ? `${prefix}.${key}` : key
    if (typeof value === 'function') out.push(path)
    else if (value && typeof value === 'object') out.push(...flattenMethods(value as Record<string, unknown>, path))
  }
  return out.sort()
}

/**
 * Method paths declared by `interface DeskhandApi` in `shared/api.ts`.
 *
 * A tiny brace-aware scan rather than a TS parser: the file is types only, and
 * the shape being read is `namespace: { name(...): ... }` at two levels.
 */
function declaredMethods(): string[] {
  const source = readFileSync(resolve(__dirname, '../shared/api.ts'), 'utf8')
  const start = source.indexOf('export interface DeskhandApi')
  const body = source.slice(source.indexOf('{', start))
  // Drop comments first: a `//` line mentioning `foo()` must not become a method.
  const withoutComments = body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')

  const out: string[] = []
  const stack: string[] = []
  let depth = 0

  for (const line of withoutComments.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue

    // `namespace: {` opens a namespace; a method is `name(...)` at that depth.
    const namespace = /^([A-Za-z]+)\s*:\s*\{\s*$/.exec(trimmed)
    if (namespace) {
      stack.push(namespace[1])
      depth += 1
      continue
    }

    const method = /^([A-Za-z]+)\s*[<(]/.exec(trimmed)
    if (method && stack.length > 0) {
      out.push(`${stack.join('.')}.${method[1]}`)
      // A signature may open or close a brace on its own line; count it here,
      // because this branch skips the bookkeeping below.
      depth += (trimmed.match(/\{/g) ?? []).length - (trimmed.match(/\}/g) ?? []).length
      continue
    }

    const closes = (trimmed.match(/\}/g) ?? []).length
    const opens = (trimmed.match(/\{/g) ?? []).length
    if (closes > opens) {
      for (let i = 0; i < closes - opens && stack.length > 0; i += 1) stack.pop()
    }
    depth += opens - closes
    if (depth <= 0) break
  }

  return out.sort()
}

describe('preload: the exposed bridge', () => {
  it('exposes exactly the namespaces of DeskhandApi', () => {
    const api = exposed.api as Record<string, unknown>
    expect(Object.keys(api).sort()).toEqual([
      'agent',
      'agentCursor',
      'agentPresenter',
      'drawing',
      'onboarding',
      'overlay',
      'permissions',
      'settings',
      'tts',
      'voice'
    ])
  })

  it('exposes every method that api.ts declares, and nothing else', () => {
    const exposedMethods = flattenMethods(exposed.api as Record<string, unknown>)
    expect(exposedMethods).toEqual(declaredMethods())
  })

  it('matches the snapshot of the method set', () => {
    expect(flattenMethods(exposed.api as Record<string, unknown>)).toMatchSnapshot()
  })

  it('keeps the sanitizer honest: the declaration scan finds the known methods', () => {
    // Guards the scanner itself — a broken scan would make the test above vacuous.
    const declared = declaredMethods()
    expect(declared).toContain('overlay.send')
    expect(declared).toContain('settings.hold')
    expect(declared).toContain('voice.onDownloadProgress')
    expect(declared).not.toContain('overlay.nope')
    expect(declared.length).toBeGreaterThanOrEqual(45)
  })
})

describe('preload: nothing but the bridge', () => {
  it('never hands ipcRenderer or a Node API to the page', () => {
    const api = exposed.api as Record<string, unknown>
    expect(api.ipcRenderer).toBeUndefined()
    expect(api.require).toBeUndefined()
    expect(api.process).toBeUndefined()
  })

  it('returns an unsubscribe function from every subscription', () => {
    const api = exposed.api as Record<string, unknown>
    const overlay = api.overlay as Record<string, (...args: unknown[]) => unknown>
    const off = overlay.onState(() => undefined) as () => void
    expect(typeof off).toBe('function')
    expect(() => off()).not.toThrow()
  })
})
