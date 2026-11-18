import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The hotkey module keeps exactly one piece of state — which accelerator is
 * currently claimed — and three decisions: does this replace the old binding, is
 * the combination free, and what happens when macOS refuses it.
 *
 * `globalShortcut` is mocked: registering a real accelerator on this machine would
 * steal the combination from the user.
 */

const shortcut = vi.hoisted(() => ({
  /** Accelerators the fake OS considers already taken by another app. */
  taken: new Set<string>(),
  registered: new Set<string>(),
  calls: [] as Array<{ op: string; accelerator: string }>,
  throwOnRegister: false
}))

vi.mock('electron', () => ({
  globalShortcut: {
    register: (accelerator: string) => {
      shortcut.calls.push({ op: 'register', accelerator })
      if (shortcut.throwOnRegister) throw new Error('Invalid accelerator')
      if (shortcut.taken.has(accelerator)) return false
      shortcut.registered.add(accelerator)
      return true
    },
    unregister: (accelerator: string) => {
      shortcut.calls.push({ op: 'unregister', accelerator })
      shortcut.registered.delete(accelerator)
    },
    isRegistered: (accelerator: string) => shortcut.registered.has(accelerator)
  }
}))

/** Fresh module per test: the claimed accelerator is module state. */
async function loadHotkey(): Promise<typeof import('./hotkey')> {
  vi.resetModules()
  return import('./hotkey')
}

beforeEach(() => {
  shortcut.taken.clear()
  shortcut.registered.clear()
  shortcut.calls.length = 0
  shortcut.throwOnRegister = false
})

describe('registerHotkey: the first binding', () => {
  it('claims the accelerator and reports it', async () => {
    const { registerHotkey } = await loadHotkey()
    const handler = vi.fn()

    expect(registerHotkey('Alt+Space', handler)).toEqual({ ok: true, accelerator: 'Alt+Space' })
    expect(shortcut.registered.has('Alt+Space')).toBe(true)
  })

  it('trims the accelerator before claiming it', async () => {
    const { registerHotkey } = await loadHotkey()
    expect(registerHotkey('  Alt+Space  ', () => undefined).ok).toBe(true)
    expect(shortcut.registered.has('Alt+Space')).toBe(true)
  })

  it('refuses an empty combination without touching the OS', async () => {
    const { registerHotkey } = await loadHotkey()

    expect(registerHotkey('   ', () => undefined)).toEqual({
      ok: false,
      accelerator: '',
      message: 'Комбинация не задана.'
    })
    expect(shortcut.calls).toEqual([])
  })
})

describe('registerHotkey: replacing a binding', () => {
  it('releases the previous accelerator before claiming the next one', async () => {
    const { registerHotkey } = await loadHotkey()
    registerHotkey('Alt+Space', () => undefined)
    shortcut.calls.length = 0

    expect(registerHotkey('Alt+Shift+Space', () => undefined).ok).toBe(true)
    expect(shortcut.calls).toEqual([
      { op: 'unregister', accelerator: 'Alt+Space' },
      { op: 'register', accelerator: 'Alt+Shift+Space' }
    ])
    expect(shortcut.registered.has('Alt+Shift+Space')).toBe(true)
    expect(shortcut.registered.has('Alt+Space')).toBe(false)
  })

  it('keeps the old binding out of the OS when the new one is taken', async () => {
    const { registerHotkey } = await loadHotkey()
    registerHotkey('Alt+Space', () => undefined)
    shortcut.taken.add('Cmd+Shift+K')

    const result = registerHotkey('Cmd+Shift+K', () => undefined)

    expect(result.ok).toBe(false)
    expect(result.message).toBe('Комбинация занята другим приложением или недопустима.')
    // The old one is released first, so the app is left with no binding rather
    // than with a stale accelerator pointing at something no longer claimed.
    expect(shortcut.registered.size).toBe(0)
  })

  it('treats re-registering the same live accelerator as a no-op', async () => {
    const { registerHotkey } = await loadHotkey()
    registerHotkey('Alt+Space', () => undefined)
    shortcut.calls.length = 0

    expect(registerHotkey('Alt+Space', () => undefined)).toEqual({ ok: true, accelerator: 'Alt+Space' })
    expect(shortcut.calls).toEqual([])
  })

  it('re-registers the same accelerator when the OS lost it', async () => {
    const { registerHotkey } = await loadHotkey()
    registerHotkey('Alt+Space', () => undefined)
    // macOS drops registrations on session switches; the cached accelerator then lies.
    shortcut.registered.clear()

    expect(registerHotkey('Alt+Space', () => undefined).ok).toBe(true)
    expect(shortcut.registered.has('Alt+Space')).toBe(true)
  })

  it('survives a throw from the OS and reports it as a refusal', async () => {
    const { registerHotkey } = await loadHotkey()
    shortcut.throwOnRegister = true

    const result = registerHotkey('Alt+Space', () => undefined)

    expect(result.ok).toBe(false)
    expect(result.message).toBe('Комбинация занята другим приложением или недопустима.')
    expect(shortcut.registered.size).toBe(0)
  })
})

describe('unregisterHotkey', () => {
  it('releases the binding and forgets it', async () => {
    const { registerHotkey, unregisterHotkey } = await loadHotkey()
    registerHotkey('Alt+Space', () => undefined)

    unregisterHotkey()

    expect(shortcut.registered.size).toBe(0)
  })

  it('does nothing when nothing was registered', async () => {
    const { unregisterHotkey } = await loadHotkey()
    shortcut.calls.length = 0

    unregisterHotkey()

    expect(shortcut.calls).toEqual([])
  })
})
