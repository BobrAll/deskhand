import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/** A controllable stand-in for the helper child process. */
const state = vi.hoisted(() => ({
  children: [] as Array<{
    args: string[]
    stdout: { emit: (line: string) => void; closed: boolean }
    stderr: { emit: (text: string) => void }
    exit: (code: number | null) => void
    fail: (error: Error) => void
    killed: string | null
    kill: (signal: string) => void
    lineHandler: ((line: string) => void) | null
    stderrHandler: ((chunk: Buffer) => void) | null
    exitHandler: ((code: number | null) => void) | null
    errorHandler: ((error: Error) => void) | null
  }>,
  spawnThrows: false,
  timers: [] as Array<{ fn: () => void; ms: number; cleared: boolean }>
}))

vi.mock('node:child_process', () => ({
  spawn: (_binary: string, args: string[]) => {
    if (state.spawnThrows) throw new Error('spawn failed')
    const child = {
      args,
      stdout: {
        emit: (line: string) => child.lineHandler?.(line),
        closed: false
      },
      stderr: {
        on(_event: string, handler: (chunk: Buffer) => void) {
          child.stderrHandler = handler
          return child.stderr
        },
        emit: (text: string) => child.stderrHandler?.(Buffer.from(text))
      },
      on(event: string, handler: unknown) {
        if (event === 'exit') child.exitHandler = handler as (code: number | null) => void
        if (event === 'error') child.errorHandler = handler as (error: Error) => void
        return child
      },
      exit: (code: number | null) => child.exitHandler?.(code),
      fail: (error: Error) => child.errorHandler?.(error),
      killed: null as string | null,
      kill: (signal: string) => {
        child.killed = signal
      },
      lineHandler: null as ((line: string) => void) | null,
      stderrHandler: null as ((chunk: Buffer) => void) | null,
      exitHandler: null as ((code: number | null) => void) | null,
      errorHandler: null as ((error: Error) => void) | null
    }
    state.children.push(child)
    return child
  }
}))

vi.mock('node:readline', () => ({
  createInterface: (_options: { input: { emit: (line: string) => void } }) => ({
    on(_event: string, handler: (line: string) => void) {
      // `input` is the child's stdout: hook the handler onto it.
      const child = state.children[state.children.length - 1]
      child.lineHandler = handler
      return this
    },
    close() {
      const child = state.children[state.children.length - 1]
      if (child) child.stdout.closed = true
    }
  })
}))

import { MODIFIER_ONLY, VoiceKeyListener, parseAccelerator } from './listen'

const COMMAND = 0x00100000
const SHIFT = 0x00020000
const CONTROL = 0x00040000
const OPTION = 0x00080000
const FN = 0x00800000

beforeEach(() => {
  state.children = []
  state.spawnThrows = false
  state.timers = []
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
    fn: () => void,
    ms?: number
  ) => {
    const timer = { fn, ms: ms ?? 0, cleared: false }
    state.timers.push(timer)
    return timer as unknown as NodeJS.Timeout
  }) as unknown as typeof setTimeout)
  vi.spyOn(globalThis, 'clearTimeout').mockImplementation(((timer: { cleared?: boolean }) => {
    if (timer) timer.cleared = true
  }) as unknown as typeof clearTimeout)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('parseAccelerator', () => {
  it('parses a modifier and a key', () => {
    expect(parseAccelerator('Alt+Shift+Space')).toEqual({
      keyCode: 49,
      flags: OPTION | SHIFT
    })
  })

  it('accepts every modifier alias', () => {
    expect(parseAccelerator('CommandOrControl+a')).toBeNull()
    expect(parseAccelerator('Cmd+a')).toEqual({ keyCode: 0, flags: COMMAND })
    expect(parseAccelerator('Command+a')).toEqual({ keyCode: 0, flags: COMMAND })
    expect(parseAccelerator('Ctrl+a')).toEqual({ keyCode: 0, flags: CONTROL })
    expect(parseAccelerator('Control+a')).toEqual({ keyCode: 0, flags: CONTROL })
    expect(parseAccelerator('Option+a')).toEqual({ keyCode: 0, flags: OPTION })
  })

  it('is case-insensitive and tolerates spaces around the parts', () => {
    expect(parseAccelerator('alt + shift + space')).toEqual({
      keyCode: 49,
      flags: OPTION | SHIFT
    })
    expect(parseAccelerator('  ALT+SPACE ')).toEqual({ keyCode: 49, flags: OPTION })
  })

  it('parses the keys a push-to-talk shortcut may use', () => {
    expect(parseAccelerator('Alt+F5')).toEqual({ keyCode: 96, flags: OPTION })
    expect(parseAccelerator('Alt+PageDown')).toEqual({ keyCode: 121, flags: OPTION })
    expect(parseAccelerator('Alt+,')).toEqual({ keyCode: 43, flags: OPTION })
    expect(parseAccelerator('Alt+0')).toEqual({ keyCode: 29, flags: OPTION })
  })

  it('rejects a bare key: a tap needs at least one modifier', () => {
    expect(parseAccelerator('space')).toBeNull()
    expect(parseAccelerator('f5')).toBeNull()
  })

  it('rejects an empty string', () => {
    expect(parseAccelerator('')).toBeNull()
    expect(parseAccelerator('   ')).toBeNull()
  })

  it('parses a hold of two or more modifiers without a key', () => {
    expect(parseAccelerator('Control+Alt')).toEqual({
      keyCode: MODIFIER_ONLY,
      flags: CONTROL | OPTION
    })
    expect(parseAccelerator('Fn+Control')).toEqual({
      keyCode: MODIFIER_ONLY,
      flags: FN | CONTROL
    })
  })

  it('rejects a single modifier, which would fire on ordinary typing', () => {
    expect(parseAccelerator('Alt')).toBeNull()
    expect(parseAccelerator('Control+Control')).toBeNull()
  })

  it('rejects two non-modifier keys', () => {
    expect(parseAccelerator('Alt+a+b')).toBeNull()
  })

  it('rejects an unknown key or modifier', () => {
    expect(parseAccelerator('Hyper+a')).toBeNull()
    expect(parseAccelerator('Alt+ж')).toBeNull()
    expect(parseAccelerator('Alt+f21')).toBeNull()
  })
})

describe('VoiceKeyListener: starting', () => {
  function listener(): {
    listener: VoiceKeyListener
    events: string[]
    errors: string[]
  } {
    const events: string[] = []
    const errors: string[] = []
    return {
      listener: new VoiceKeyListener({
        binary: '/bin/helper',
        onEvent: (event) => events.push(event),
        onError: (message) => errors.push(message)
      }),
      events,
      errors
    }
  }

  it('spawns the helper with the key code, the mask and `swallow`', () => {
    const { listener: tap } = listener()

    expect(tap.start('Alt+Space')).toBeNull()
    expect(state.children[0].args).toEqual(['voice', '49', String(OPTION), 'swallow'])
  })

  it('sends a modifier-only hold without `swallow`', () => {
    const { listener: tap } = listener()

    expect(tap.start('Control+Alt')).toBeNull()
    expect(state.children[0].args).toEqual([
      'voice',
      String(MODIFIER_ONLY),
      String(CONTROL | OPTION)
    ])
  })

  it('omits `swallow` when the options say so', () => {
    const tap = new VoiceKeyListener({
      binary: '/bin/helper',
      swallow: false,
      onEvent: () => undefined,
      onError: () => undefined
    })

    tap.start('Alt+Space')

    expect(state.children[0].args).toEqual(['voice', '49', String(OPTION)])
  })

  it('returns an error and spawns nothing for an unusable combination', () => {
    const { listener: tap } = listener()

    expect(tap.start('space')).toBe('Комбинация «space» не подходит для удержания.')
    expect(state.children).toHaveLength(0)
    expect(tap.listening).toBe(false)
  })

  it('does not restart for the same combination while it is running', () => {
    const { listener: tap } = listener()
    tap.start('Alt+Space')

    expect(tap.start('Alt+Space')).toBeNull()
    expect(state.children).toHaveLength(1)
  })

  it('restarts for a different combination', () => {
    const { listener: tap } = listener()
    tap.start('Alt+Space')
    tap.start('Alt+Shift+Space')

    expect(state.children).toHaveLength(2)
    expect(state.children[0].killed).toBe('SIGTERM')
    expect(tap.accelerator).toBe('Alt+Shift+Space')
  })

  it('reports a spawn that throws', () => {
    const { listener: tap, errors } = listener()
    state.spawnThrows = true

    expect(tap.start('Alt+Space')).toBeNull()
    expect(errors).toEqual(['spawn failed'])
    expect(tap.listening).toBe(false)
  })
})

describe('VoiceKeyListener: reading helper events', () => {
  function started(): { tap: VoiceKeyListener; events: string[]; errors: string[] } {
    const events: string[] = []
    const errors: string[] = []
    const tap = new VoiceKeyListener({
      binary: '/bin/helper',
      onEvent: (event) => events.push(event),
      onError: (message) => errors.push(message)
    })
    tap.start('Alt+Space')
    return { tap, events, errors }
  }

  it('forwards press, release, cancel and reenabled', () => {
    const { events } = started()
    const child = state.children[0]

    for (const event of ['press', 'release', 'cancel', 'reenabled']) {
      child.stdout.emit(JSON.stringify({ event }))
    }

    expect(events).toEqual(['press', 'release', 'cancel', 'reenabled'])
  })

  it('forwards `ready` too, so the caller can show the state', () => {
    const { events } = started()

    state.children[0].stdout.emit('{"event":"ready"}')

    expect(events).toEqual(['ready'])
  })

  it('ignores blank lines, garbage and lines without an event', () => {
    const { events } = started()
    const child = state.children[0]

    child.stdout.emit('')
    child.stdout.emit('   ')
    child.stdout.emit('not json')
    child.stdout.emit('{"no":"event"}')

    expect(events).toEqual([])
  })

  it('maps `accessibility-denied` to an actionable message', () => {
    const { errors, tap } = started()

    state.children[0].stdout.emit('{"error":"accessibility-denied"}')

    expect(errors).toEqual([
      'Нет доступа «Универсальный доступ» — удержание клавиши не работает.'
    ])
    expect(tap.lastError).toBe(errors[0])
  })

  it('maps `tap-create-failed` to an actionable message', () => {
    const { errors } = started()

    state.children[0].stdout.emit('{"error":"tap-create-failed"}')

    expect(errors).toEqual([
      'Не удалось перехватить клавиатуру: проверь «Универсальный доступ» и перезапусти приложение.'
    ])
  })

  it('passes an unknown error code through with a prefix', () => {
    const { errors } = started()

    state.children[0].stdout.emit('{"error":"weird"}')

    expect(errors).toEqual(['Слушатель клавиатуры: weird'])
  })

  it('does not forward an event on the same line as an error', () => {
    const { events, errors } = started()

    state.children[0].stdout.emit('{"error":"weird","event":"press"}')

    expect(errors).toHaveLength(1)
    expect(events).toEqual([])
  })

  it('clears the error on `ready`', () => {
    const { tap } = started()
    state.children[0].stdout.emit('{"error":"weird"}')
    expect(tap.lastError).not.toBeNull()

    state.children[0].stdout.emit('{"event":"ready"}')

    expect(tap.lastError).toBeNull()
  })

  it('logs the first line of stderr only', () => {
    started()

    state.children[0].stderr.emit('first line\nsecond line\n')

    expect(console.warn).toHaveBeenCalledWith('[voice] listener:', 'first line')
  })

  it('ignores empty stderr', () => {
    started()

    state.children[0].stderr.emit('   \n')

    expect(console.warn).not.toHaveBeenCalled()
  })
})

describe('VoiceKeyListener: restart and stop', () => {
  function started(): { tap: VoiceKeyListener; errors: string[] } {
    const errors: string[] = []
    const tap = new VoiceKeyListener({
      binary: '/bin/helper',
      onEvent: () => undefined,
      onError: (message) => errors.push(message)
    })
    tap.start('Alt+Space')
    return { tap, errors }
  }

  it('restarts with a 1 s backoff after a process that had reported ready', () => {
    const { tap } = started()
    state.children[0].stdout.emit('{"event":"ready"}')

    state.children[0].exit(0)

    expect(state.timers).toHaveLength(1)
    expect(state.timers[0].ms).toBe(1000)
    state.timers[0].fn()
    expect(state.children).toHaveLength(2)
    expect(tap.listening).toBe(true)
  })

  it('backs off exponentially and gives up instead of spinning every second', () => {
    // `launch()` used to reset `failures` whenever the helper reported `ready`,
    // and a restart only happens after `ready` — so the exponential growth and
    // the six-failure cap were unreachable and a dying helper was respawned
    // every second, forever.
    const { tap } = started()
    const delays: number[] = []

    for (let attempt = 0; attempt < 10; attempt += 1) {
      const child = state.children[state.children.length - 1]
      child.stdout.emit('{"event":"ready"}')
      const timersBefore = state.timers.length
      child.exit(0)
      if (state.timers.length === timersBefore) break
      const timer = state.timers[state.timers.length - 1]
      delays.push(timer.ms)
      timer.fn()
    }

    expect(delays).toEqual([1000, 2000, 4000, 8000, 16000, 30000])
    expect(state.children).toHaveLength(7)
    expect(tap.listening).toBe(false)
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('failed 6 times in a row')
    )
  })

  it('forgets the failures when the listener is started again', () => {
    const { tap } = started()
    // Exhaust the retries.
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const child = state.children[state.children.length - 1]
      child.stdout.emit('{"event":"ready"}')
      const timersBefore = state.timers.length
      child.exit(0)
      if (state.timers.length === timersBefore) break
      state.timers[state.timers.length - 1].fn()
    }

    expect(tap.start('Alt+Shift+Space')).toBeNull()
    const child = state.children[state.children.length - 1]
    const timersBefore = state.timers.length
    child.stdout.emit('{"event":"ready"}')
    child.exit(0)

    expect(state.timers.length).toBe(timersBefore + 1)
    expect(state.timers[state.timers.length - 1].ms).toBe(1000)
  })

  it('does not retry a process that never reported ready', () => {
    const { errors } = started()

    state.children[0].exit(1)

    expect(errors).toEqual([
      'Слушатель клавиатуры не запустился — проверь «Универсальный доступ».'
    ])
    expect(state.timers).toHaveLength(0)
  })

  it('reports a process error and schedules a restart', () => {
    const { errors } = started()
    state.children[0].stdout.emit('{"event":"ready"}')

    state.children[0].fail(new Error('ENOENT'))

    expect(errors).toEqual(['ENOENT'])
    expect(state.timers).toHaveLength(1)
  })

  it('does nothing when the process exits after stop()', () => {
    const { tap } = started()
    state.children[0].stdout.emit('{"event":"ready"}')

    tap.stop()
    state.children[0].exit(0)

    expect(state.timers).toHaveLength(0)
  })

  it('ignores the delayed exit of a child that start() already replaced', () => {
    const { tap } = started()
    const replaced = state.children[0]
    replaced.stdout.emit('{"event":"ready"}')

    tap.start('Alt+Shift+Space')
    expect(replaced.killed).toBe('SIGTERM')

    // The old helper was signalled but has not exited yet. When it finally does,
    // its exit belongs to a process this listener no longer owns.
    replaced.exit(0)

    expect(state.timers).toHaveLength(0)
    expect(state.children).toHaveLength(2)
    expect(state.children[1].killed).toBeNull()
    expect(tap.listening).toBe(true)
    expect(tap.accelerator).toBe('Alt+Shift+Space')
  })

  it('ignores a delayed error from a child that start() already replaced', () => {
    const { tap, errors } = started()
    const replaced = state.children[0]
    replaced.stdout.emit('{"event":"ready"}')

    tap.start('Alt+Shift+Space')
    replaced.fail(new Error('ENOENT'))

    expect(errors).toEqual([])
    expect(tap.lastError).toBeNull()
    expect(state.timers).toHaveLength(0)
    expect(tap.listening).toBe(true)
  })

  it('stop() kills the process, clears the accelerator and any pending restart', () => {
    const { tap } = started()
    state.children[0].stdout.emit('{"event":"ready"}')
    state.children[0].exit(0)

    tap.stop()

    expect(state.timers[0].cleared).toBe(true)
    expect(tap.accelerator).toBeNull()
    expect(tap.listening).toBe(false)
  })

  it('stop() is safe when nothing is running', () => {
    const tap = new VoiceKeyListener({
      binary: '/bin/helper',
      onEvent: () => undefined,
      onError: () => undefined
    })

    expect(() => tap.stop()).not.toThrow()
    expect(tap.listening).toBe(false)
  })

  it('a restart timer that fires after stop() does not launch anything', () => {
    const { tap } = started()
    state.children[0].stdout.emit('{"event":"ready"}')
    state.children[0].exit(0)

    tap.stop()
    state.timers[0].fn()

    expect(state.children).toHaveLength(1)
  })
})
