import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * `helper.ts` keeps the resolved binary path in a module-level cache, so every
 * test imports a fresh copy. Electron, the file system and `child_process` are
 * mocked: no real helper is ever spawned (see docs/refactor/RULES.md).
 */
const state = vi.hoisted(() => ({
  /** Paths that `existsSync` reports as present. */
  existing: new Set<string>(),
  isPackaged: false,
  appPath: '/app',
  cwd: '/work',
  resourcesPath: '/resources',
  /** Every `execFile` call, in order. */
  calls: [] as Array<{ file: string; args: string[]; options: Record<string, unknown> }>,
  /** Answer per binary/command: the first matching rule wins. */
  handler: null as
    | null
    | ((file: string, args: string[], options: Record<string, unknown>) => {
        error?: Error | null
        stdout?: string
      }),
  /** Lines pushed to the `watch` process. */
  watchLines: [] as string[],
  watchKilled: 0,
  watchClosed: 0,
  watchSpawnError: false,
  watchLineHandler: null as null | ((line: string) => void)
}))

/** `process.resourcesPath` does not exist outside Electron; the module reads it. */
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

vi.mock('node:child_process', () => ({
  execFile: (
    file: string,
    args: string[],
    options: Record<string, unknown>,
    callback: (error: Error | null, stdout: string) => void
  ) => {
    state.calls.push({ file, args, options })
    const answer = state.handler?.(file, args, options) ?? { error: new Error('no handler') }
    // Answer on a later tick, as the real call does.
    queueMicrotask(() => callback(answer.error ?? null, answer.stdout ?? ''))
  },
  spawn: () => {
    const listeners = new Map<string, (value: unknown) => void>()
    const child = {
      stdout: {},
      on(event: string, handler: (value: unknown) => void) {
        listeners.set(event, handler)
        if (event === 'error' && state.watchSpawnError) queueMicrotask(() => handler(new Error('ENOENT')))
        return child
      },
      kill() {
        state.watchKilled += 1
        return true
      }
    }
    // The readline interface is mocked below; it drains `state.watchLines`.
    queueMicrotask(() => {
      const lineHandler = state.watchLineHandler
      for (const line of state.watchLines) lineHandler?.(line)
    })
    return child
  }
}))

vi.mock('node:readline', () => ({
  createInterface: () => ({
    on(_event: string, handler: (line: string) => void) {
      state.watchLineHandler = handler
      return this
    },
    close() {
      state.watchClosed += 1
    }
  })
}))

type HelperModule = typeof import('./helper')

let helper: HelperModule

async function load(): Promise<HelperModule> {
  vi.resetModules()
  return import('./helper')
}

function answerWith(rules: Record<string, { error?: Error | null; stdout?: string }>): void {
  state.handler = (_file, args) => {
    const key = args[0] ?? ''
    return rules[key] ?? { error: new Error(`unexpected: ${args.join(' ')}`) }
  }
}

/** The `execFile` calls made against the helper binary (not osascript). */
function helperCalls(): Array<{ file: string; args: string[]; options: Record<string, unknown> }> {
  return state.calls.filter((call) => call.file === '/resources/smartcursor-helper')
}

beforeEach(async () => {
  state.existing = new Set(['/resources/smartcursor-helper'])
  state.isPackaged = true
  state.calls = []
  state.handler = null
  state.watchLines = []
  state.watchKilled = 0
  state.watchClosed = 0
  state.watchSpawnError = false
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  helper = await load()
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('helperBinary: where the binary is looked up', () => {
  it('uses the resources directory in a packaged app', () => {
    expect(helper.helperBinary()).toBe('/resources/smartcursor-helper')
  })

  it('looks next to the app path and then in the cwd when unpackaged', async () => {
    state.isPackaged = false
    state.existing = new Set([`${process.cwd()}/resources/smartcursor-helper`])
    helper = await load()

    expect(helper.helperBinary()).toBe(`${process.cwd()}/resources/smartcursor-helper`)
  })

  it('prefers the app path over the cwd when unpackaged', async () => {
    state.isPackaged = false
    state.existing = new Set([
      '/app/resources/smartcursor-helper',
      '/work/resources/smartcursor-helper'
    ])
    helper = await load()

    expect(helper.helperBinary()).toBe('/app/resources/smartcursor-helper')
  })

  it('returns null and warns when the binary is missing', async () => {
    state.existing = new Set()
    helper = await load()

    expect(helper.helperBinary()).toBeNull()
    expect(console.warn).toHaveBeenCalledWith(
      '[native] helper binary not found, falling back to osascript'
    )
  })

  it('caches the answer, including the negative one', async () => {
    state.existing = new Set()
    helper = await load()

    expect(helper.helperBinary()).toBeNull()
    state.existing = new Set(['/resources/smartcursor-helper'])
    expect(helper.helperBinary()).toBeNull()
    expect(console.warn).toHaveBeenCalledTimes(1)
  })
})

describe('runHelper: the shared call shape', () => {
  it('passes the arguments through with a timeout and an 8 MB buffer', async () => {
    answerWith({ cursor: { stdout: '{"ok":true,"x":1,"y":2}' } })

    await helper.helperCursor()

    expect(helperCalls()).toHaveLength(1)
    const call = helperCalls()[0]
    expect(call.args).toEqual(['cursor'])
    expect(call.options.timeout).toBe(4000)
    expect(call.options.maxBuffer).toBe(8 * 1024 * 1024)
  })

  it('returns null without calling anything when the binary is missing', async () => {
    state.existing = new Set()
    helper = await load()

    expect(await helper.helperCursor()).toBeNull()
    expect(state.calls).toHaveLength(0)
  })

  it('turns a non-zero exit into null', async () => {
    answerWith({ cursor: { error: new Error('exit 1'), stdout: '{"ok":true}' } })

    expect(await helper.helperCursor()).toBeNull()
  })

  it('turns invalid JSON into null', async () => {
    answerWith({ cursor: { stdout: 'not json at all' } })

    expect(await helper.helperCursor()).toBeNull()
  })

  it('turns an empty answer into null', async () => {
    answerWith({ cursor: { stdout: '   ' } })

    expect(await helper.helperCursor()).toBeNull()
  })

  it('reads a payload with a `false` ok as a failure, not as a crash', async () => {
    answerWith({ cursor: { stdout: '{"ok":false,"error":"accessibility-denied"}' } })

    expect(await helper.helperCursor()).toBeNull()
  })
})

describe('helperFront: the frontmost app', () => {
  it('maps a full payload', async () => {
    answerWith({
      front: {
        stdout: JSON.stringify({
          ok: true,
          bundleId: 'com.apple.Safari',
          name: 'Safari',
          pid: 512,
          windowId: 7,
          title: 'Статья',
          bounds: { X: 0, Y: 25, Width: 1440, Height: 875 },
          accessibility: true
        })
      }
    })

    expect(await helper.helperFront()).toEqual({
      bundleId: 'com.apple.Safari',
      name: 'Safari',
      pid: 512,
      windowId: 7,
      windowTitle: 'Статья',
      bounds: { x: 0, y: 25, width: 1440, height: 875 },
      accessibility: true
    })
  })

  it('accepts lowercase bounds keys and numeric strings', async () => {
    answerWith({
      front: {
        stdout: JSON.stringify({
          ok: true,
          bundleId: 'a',
          pid: '512',
          bounds: { x: '1', y: '2', width: '3', height: '4' }
        })
      }
    })

    const front = await helper.helperFront()
    expect(front?.pid).toBe(512)
    expect(front?.bounds).toEqual({ x: 1, y: 2, width: 3, height: 4 })
  })

  it('falls back to the bundle id for the name and drops an empty title', async () => {
    answerWith({
      front: { stdout: JSON.stringify({ ok: true, bundleId: 'a.b', pid: 1, title: '' }) }
    })

    const front = await helper.helperFront()
    expect(front?.name).toBe('a.b')
    expect(front?.windowTitle).toBeNull()
  })

  it('returns null bounds when any side is not a number', async () => {
    answerWith({
      front: { stdout: JSON.stringify({ ok: true, bundleId: 'a', pid: 1, bounds: { x: 1 } }) }
    })

    expect((await helper.helperFront())?.bounds).toBeNull()
  })

  it('returns null when the pid is missing', async () => {
    answerWith({ front: { stdout: JSON.stringify({ ok: true, bundleId: 'a' }) } })

    expect(await helper.helperFront()).toBeNull()
  })

  it('degrades to osascript when the helper fails', async () => {
    state.handler = (file, args) => {
      if (file === 'osascript') {
        const script = args.join(' ')
        // The three scripts are distinguished by their verb, not by the bundle id:
        // every one of them mentions "bundle identifier".
        if (script.includes('unix id')) return { stdout: '900' }
        if (script.includes('get name')) return { stdout: 'Notes' }
        if (script.includes('bundle identifier')) return { stdout: 'com.apple.Notes' }
      }
      return { error: new Error('helper failed') }
    }

    expect(await helper.helperFront()).toEqual({
      bundleId: 'com.apple.Notes',
      name: 'Notes',
      pid: 900,
      windowId: null,
      windowTitle: null,
      bounds: null,
      accessibility: false
    })
  })

  it('returns null when osascript cannot name the frontmost app either', async () => {
    answerWith({ front: { error: new Error('helper failed') } })
    state.handler = () => ({ error: new Error('osascript failed') })

    expect(await helper.helperFront()).toBeNull()
  })

  it('falls back to pid 0 when osascript cannot read the unix id', async () => {
    state.handler = (file, args) => {
      if (file === 'osascript') {
        const script = args.join(' ')
        if (script.includes('bundle identifier')) return { stdout: 'com.apple.Notes' }
        return { error: new Error('no') }
      }
      return { error: new Error('helper failed') }
    }

    const front = await helper.helperFront()
    expect(front?.pid).toBe(0)
    expect(front?.name).toBe('com.apple.Notes')
  })
})

describe('helperSendKey and helperActivate', () => {
  it('sends `copy`/`paste` as the helper command', async () => {
    answerWith({ copy: { stdout: '{"ok":true}' }, paste: { stdout: '{"ok":true}' } })

    expect(await helper.helperSendKey('copy')).toBe(true)
    expect(await helper.helperSendKey('paste')).toBe(true)
    expect(helperCalls().map((call) => call.args)).toEqual([['copy'], ['paste']])
  })

  it('degrades to an osascript keystroke', async () => {
    state.handler = (file, args) => {
      if (file === 'osascript' && args.join(' ').includes('keystroke "c"')) return { stdout: '' }
      return { error: new Error('helper failed') }
    }

    expect(await helper.helperSendKey('copy')).toBe(true)
  })

  it('returns false when both the helper and osascript fail', async () => {
    state.handler = () => ({ error: new Error('failed') })

    expect(await helper.helperSendKey('paste')).toBe(false)
  })

  it('activates by bundle id first', async () => {
    answerWith({ activate: { stdout: '{"ok":true}' } })

    expect(await helper.helperActivate({ bundleId: 'com.apple.Safari', pid: 5 })).toBe(true)
    expect(helperCalls()[0].args).toEqual(['activate', 'com.apple.Safari'])
  })

  it('falls back to the pid when the bundle id is refused', async () => {
    state.handler = (_file, args) =>
      args[1] === 'com.apple.Safari' ? { error: new Error('no') } : { stdout: '{"ok":true}' }

    expect(await helper.helperActivate({ bundleId: 'com.apple.Safari', pid: 5 })).toBe(true)
    expect(helperCalls()[1].args).toEqual(['activate', '5'])
  })

  it('falls back to osascript last, escaping quotes in the bundle id', async () => {
    state.handler = (file) => (file === 'osascript' ? { stdout: '' } : { error: new Error('no') })

    expect(await helper.helperActivate({ bundleId: 'a"b', pid: 0 })).toBe(true)
    expect(state.calls.some((call) => call.file === 'osascript')).toBe(true)
  })

  it('returns false when there is nothing to activate by', async () => {
    state.handler = () => ({ error: new Error('no') })

    expect(await helper.helperActivate({ bundleId: '', pid: 0 })).toBe(false)
  })
})

describe('input posting: rounding and arguments', () => {
  it('rounds coordinates', async () => {
    answerWith({
      move: { stdout: '{"ok":true}' },
      click: { stdout: '{"ok":true}' },
      drag: { stdout: '{"ok":true}' },
      scroll: { stdout: '{"ok":true}' }
    })

    await helper.helperMoveMouse(10.6, 20.4)
    await helper.helperClick(1.5, 2.5)
    await helper.helperDrag({ x: 3.4, y: 4.6 }, { x: 5.5, y: 6.5 })
    await helper.helperScroll(-12.7, 33.2)

    expect(helperCalls().map((call) => call.args)).toEqual([
      ['move', '11', '20'],
      ['click', '2', '3', 'left'],
      ['drag', '3', '5', '6', '7'],
      ['scroll', '-13', '33']
    ])
  })

  it('passes the click button through', async () => {
    answerWith({ click: { stdout: '{"ok":true}' } })

    await helper.helperClick(1, 2, 'double')

    expect(helperCalls()[0].args).toEqual(['click', '1', '2', 'double'])
  })

  it('sends typed text as base64 so Unicode survives argv', async () => {
    answerWith({ type: { stdout: '{"ok":true}' } })

    await helper.helperTypeText('привет')

    const args = helperCalls()[0].args
    expect(args[0]).toBe('type')
    expect(Buffer.from(args[1], 'base64').toString('utf8')).toBe('привет')
  })

  it('extends the timeout with the text length, capped at 30 s', async () => {
    answerWith({ type: { stdout: '{"ok":true}' } })

    await helper.helperTypeText('a'.repeat(10))
    await helper.helperTypeText('a'.repeat(5000))

    expect(helperCalls()[0].options.timeout).toBe(4400)
    expect(helperCalls()[1].options.timeout).toBe(30_000)
  })

  it('sends nothing at all for empty text, and still reports success', async () => {
    expect(await helper.helperTypeText('')).toBe(true)
    expect(state.calls).toHaveLength(0)
  })

  it('sends a key code and a modifier mask', async () => {
    answerWith({ key: { stdout: '{"ok":true}' } })

    expect(await helper.helperPressKey(1, 0x100000)).toBe(true)
    expect(helperCalls()[0].args).toEqual(['key', '1', '1048576'])
  })
})

describe('helperProbe and helperFocused', () => {
  const probePayload = {
    ok: true,
    pid: 42,
    app: 'Safari',
    chain: [{ role: 'AXButton', title: 'ok', frame: { x: 0, y: 0, width: 10, height: 10 } }],
    targets: [
      { role: 'AXButton', title: 'ok', frame: { x: 0, y: 0, width: 10, height: 10 }, pressable: 1 },
      { role: '', title: 'no role', frame: { x: 0, y: 0, width: 10, height: 10 } },
      { role: 'AXStaticText', title: 'no frame' }
    ],
    focused: { role: 'AXTextField', title: 'поле', value: 'текст' },
    elapsedMs: 12
  }

  it('passes the pid and asks for a 3 s timeout', async () => {
    answerWith({ probe: { stdout: JSON.stringify(probePayload) } })

    await helper.helperProbe(42)

    expect(helperCalls()[0].args).toEqual(['probe', '42'])
    expect(helperCalls()[0].options.timeout).toBe(3000)
  })

  it('sends a rounded point when one is given', async () => {
    answerWith({ probe: { stdout: JSON.stringify(probePayload) } })

    await helper.helperProbe(42, { x: 10.6, y: 20.2 })

    expect(helperCalls()[0].args).toEqual(['probe', '42', '11', '20'])
  })

  it('sends pid 0 for a null, zero or negative pid', async () => {
    answerWith({ probe: { stdout: JSON.stringify(probePayload) } })

    await helper.helperProbe(null)
    await helper.helperProbe(0)
    await helper.helperProbe(-5)

    expect(helperCalls().map((call) => call.args[1])).toEqual(['0', '0', '0'])
  })

  it('maps the payload and drops elements without a role or a frame', async () => {
    answerWith({ probe: { stdout: JSON.stringify(probePayload) } })

    const probe = await helper.helperProbe(42)

    expect(probe?.pid).toBe(42)
    expect(probe?.app).toBe('Safari')
    expect(probe?.elapsedMs).toBe(12)
    expect(probe?.chain).toHaveLength(1)
    expect(probe?.targets).toHaveLength(1)
    expect(probe?.targets[0].pressable).toBe(true)
    expect(probe?.focused?.value).toBe('текст')
  })

  it('treats a missing elapsed time as 0', async () => {
    answerWith({ probe: { stdout: JSON.stringify({ ok: true, pid: 1 }) } })

    expect((await helper.helperProbe(1))?.elapsedMs).toBe(0)
  })

  it('returns null when the helper did not answer ok', async () => {
    answerWith({ probe: { stdout: '{"ok":false}' } })

    expect(await helper.helperProbe(1)).toBeNull()
  })

  it('returns null when the pid is missing from the answer', async () => {
    answerWith({ probe: { stdout: '{"ok":true}' } })

    expect(await helper.helperProbe(1)).toBeNull()
  })

  it('reads the focused element and its flag values', async () => {
    answerWith({
      focused: {
        stdout: JSON.stringify({
          ok: true,
          focused: { role: 'AXTextField', editable: 1, pressable: true, actions: ['AXPress', 5] }
        })
      }
    })

    const focused = await helper.helperFocused(42)

    expect(focused?.editable).toBe(true)
    expect(focused?.pressable).toBe(true)
    expect(focused?.actions).toEqual(['AXPress'])
  })

  it('returns null for a focused element without a role, or a failed call', async () => {
    answerWith({ focused: { stdout: '{"ok":true,"focused":{"title":"x"}}' } })
    expect(await helper.helperFocused(1)).toBeNull()

    answerWith({ focused: { stdout: '{"ok":false}' } })
    expect(await helper.helperFocused(1)).toBeNull()
  })

  it('sends pid 0 when the focused call has no pid', async () => {
    answerWith({ focused: { stdout: '{"ok":true,"focused":{"role":"AXButton"}}' } })

    await helper.helperFocused(null)

    expect(helperCalls()[0].args).toEqual(['focused', '0'])
  })
})

describe('watchForAbort: the long-lived watcher', () => {
  it('spawns the helper in key mode by default', async () => {
    const spawn = vi.spyOn(await import('node:child_process'), 'spawn')
    helper.watchForAbort({ watchMouse: false }, () => undefined)

    expect(spawn).toHaveBeenCalledWith('/resources/smartcursor-helper', ['watch', 'key'], {
      stdio: ['ignore', 'pipe', 'ignore']
    })
  })

  it('asks for mouse events when requested', async () => {
    const spawn = vi.spyOn(await import('node:child_process'), 'spawn')
    helper.watchForAbort({ watchMouse: true }, () => undefined)

    expect(spawn).toHaveBeenCalledWith('/resources/smartcursor-helper', ['watch', 'mouse'], {
      stdio: ['ignore', 'pipe', 'ignore']
    })
  })

  it('returns null when the binary is missing', async () => {
    state.existing = new Set()
    helper = await load()

    expect(helper.watchForAbort({ watchMouse: true }, () => undefined)).toBeNull()
  })

  it('reports escape and mousemove lines and ignores the rest', async () => {
    state.watchLines = [
      '{"event":"escape"}',
      '{"event":"mousemove"}',
      '{"event":"other"}',
      'not json',
      '{"no":"event"}'
    ]
    const seen: string[] = []

    helper.watchForAbort({ watchMouse: true }, (reason) => seen.push(reason))
    await Promise.resolve()

    expect(seen).toEqual(['escape', 'mousemove'])
  })

  it('stop() closes the reader and kills the process', async () => {
    const watcher = helper.watchForAbort({ watchMouse: true }, () => undefined)
    watcher?.stop()

    expect(state.watchClosed).toBe(1)
    expect(state.watchKilled).toBe(1)
  })

  it('survives a spawn error', async () => {
    state.watchSpawnError = true

    expect(() => helper.watchForAbort({ watchMouse: true }, () => undefined)).not.toThrow()
    await Promise.resolve()
  })
})

describe('helperPermissions and helperCursor', () => {
  it('asks for the plain or the requesting command', async () => {
    answerWith({
      permissions: { stdout: '{"ok":true,"accessibility":true,"screenRecording":false}' },
      'request-permissions': {
        stdout: '{"ok":true,"accessibility":true,"screenRecording":true}'
      }
    })

    expect(await helper.helperPermissions(false)).toEqual({
      accessibility: true,
      screenRecording: false
    })
    expect(await helper.helperPermissions(true)).toEqual({
      accessibility: true,
      screenRecording: true
    })
    expect(helperCalls().map((call) => call.args[0])).toEqual(['permissions', 'request-permissions'])
  })

  it('returns null when the helper did not answer ok', async () => {
    answerWith({ permissions: { stdout: '{"ok":false}' } })

    expect(await helper.helperPermissions(false)).toBeNull()
  })

  it('reads the cursor position', async () => {
    answerWith({ cursor: { stdout: '{"ok":true,"x":100,"y":200}' } })

    expect(await helper.helperCursor()).toEqual({ x: 100, y: 200 })
  })

  it('returns null when a coordinate is not a number', async () => {
    answerWith({ cursor: { stdout: '{"ok":true,"x":100}' } })

    expect(await helper.helperCursor()).toBeNull()
  })
})

describe('helperRunningApps', () => {
  it('maps the helper list and drops entries without a bundle id or a name', async () => {
    answerWith({
      apps: {
        stdout: JSON.stringify({
          ok: true,
          apps: [
            { bundleId: 'com.a', name: 'A' },
            { bundleId: '', name: 'B' },
            { bundleId: 'com.c' }
          ]
        })
      }
    })

    expect(await helper.helperRunningApps()).toEqual([{ bundleId: 'com.a', name: 'A' }])
  })

  it('degrades to osascript, using the bundle id as the name', async () => {
    state.handler = (file) =>
      file === 'osascript' ? { stdout: 'com.a, com.b ,, com.c' } : { error: new Error('no') }

    expect(await helper.helperRunningApps()).toEqual([
      { bundleId: 'com.a', name: 'com.a' },
      { bundleId: 'com.b', name: 'com.b' },
      { bundleId: 'com.c', name: 'com.c' }
    ])
  })

  it('returns an empty list when osascript fails too', async () => {
    state.handler = () => ({ error: new Error('no') })

    expect(await helper.helperRunningApps()).toEqual([])
  })

  it('returns an empty list when the helper reports no apps array', async () => {
    answerWith({ apps: { stdout: '{"ok":true}' } })
    state.handler = (file) => (file === 'osascript' ? { error: new Error('no') } : { stdout: '{"ok":true}' })

    expect(await helper.helperRunningApps()).toEqual([])
  })
})
