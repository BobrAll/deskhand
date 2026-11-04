import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/** A controllable stand-in for the helper child process. */
const state = vi.hoisted(() => ({
  children: [] as Array<{
    args: string[]
    lineHandler: ((line: string) => void) | null
    stderrHandler: ((chunk: Buffer) => void) | null
    exitHandler: ((code: number | null) => void) | null
    errorHandler: ((error: Error) => void) | null
    emit: (line: string) => void
    emitStderr: (text: string) => void
    exit: (code: number | null) => void
    fail: (error: Error) => void
    killed: string | null
  }>,
  spawnThrows: false,
  timers: [] as Array<{ fn: () => void; ms: number; cleared: boolean }>
}))

vi.mock('node:child_process', () => ({
  spawn: (_binary: string, args: string[]) => {
    if (state.spawnThrows) throw new Error('spawn failed')
    const child = {
      args,
      lineHandler: null as ((line: string) => void) | null,
      stderrHandler: null as ((chunk: Buffer) => void) | null,
      exitHandler: null as ((code: number | null) => void) | null,
      errorHandler: null as ((error: Error) => void) | null,
      emit: (line: string) => child.lineHandler?.(line),
      emitStderr: (text: string) => child.stderrHandler?.(Buffer.from(text)),
      exit: (code: number | null) => child.exitHandler?.(code),
      fail: (error: Error) => child.errorHandler?.(error),
      killed: null as string | null,
      stdout: {},
      stderr: {
        on(_event: string, handler: (chunk: Buffer) => void) {
          child.stderrHandler = handler
          return child.stderr
        }
      },
      on(event: string, handler: unknown) {
        if (event === 'exit') child.exitHandler = handler as (code: number | null) => void
        if (event === 'error') child.errorHandler = handler as (error: Error) => void
        return child
      },
      kill(signal: string) {
        child.killed = signal
        return true
      }
    }
    state.children.push(child)
    return child
  }
}))

vi.mock('node:readline', () => ({
  createInterface: () => ({
    on(_event: string, handler: (line: string) => void) {
      const child = state.children[state.children.length - 1]
      child.lineHandler = handler
      return this
    },
    close() {
      // Nothing to release: the child is a stub.
    }
  })
}))

import { TrackpadGestureListener } from './listen'

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

function listener(options: Partial<{ fingers: number; holdMs: number }> = {}): {
  tap: TrackpadGestureListener
  events: string[]
  errors: string[]
} {
  const events: string[] = []
  const errors: string[] = []
  const tap = new TrackpadGestureListener({
    binary: '/bin/helper',
    fingers: options.fingers ?? 3,
    holdMs: options.holdMs ?? 400,
    onEvent: (event) => events.push(event),
    onError: (message) => errors.push(message)
  })
  return { tap, events, errors }
}

describe('TrackpadGestureListener: starting', () => {
  it('spawns the helper with the finger count and the rounded hold', () => {
    const { tap } = listener({ fingers: 3, holdMs: 400.4 })

    expect(tap.start()).toBeNull()
    expect(state.children[0].args).toEqual(['gesture', '3', '400'])
    expect(tap.listening).toBe(true)
  })

  it('passes a different finger count and hold through', () => {
    const { tap } = listener({ fingers: 4, holdMs: 900 })

    tap.start()

    expect(state.children[0].args).toEqual(['gesture', '4', '900'])
  })

  it('stops the previous process when started again', () => {
    const { tap } = listener()
    tap.start()
    tap.start()

    expect(state.children).toHaveLength(2)
    expect(state.children[0].killed).toBe('SIGTERM')
  })

  it('reports a spawn that throws, and does not claim to be listening', () => {
    const { tap, errors } = listener()
    state.spawnThrows = true

    expect(tap.start()).toBeNull()
    expect(errors).toEqual(['spawn failed'])
    expect(tap.lastError).toBe('spawn failed')
    expect(tap.listening).toBe(false)
  })
})

describe('TrackpadGestureListener: helper events', () => {
  it('forwards ready, tap, press, release and cancel', () => {
    const { tap, events } = listener()
    tap.start()

    for (const event of ['ready', 'tap', 'press', 'release', 'cancel']) {
      state.children[0].emit(JSON.stringify({ event }))
    }

    expect(events).toEqual(['ready', 'tap', 'press', 'release', 'cancel'])
  })

  it('ignores blank lines, garbage and lines without an event', () => {
    const { tap, events } = listener()
    tap.start()

    state.children[0].emit('')
    state.children[0].emit('   ')
    state.children[0].emit('not json')
    state.children[0].emit('{"no":"event"}')

    expect(events).toEqual([])
  })

  it('maps `no-trackpad` to an actionable message', () => {
    const { tap, errors } = listener()
    tap.start()

    state.children[0].emit('{"error":"no-trackpad"}')

    expect(errors).toEqual([
      'Трекпад не найден — жесты тремя пальцами недоступны, работают горячие клавиши.'
    ])
    expect(tap.lastError).toBe(errors[0])
  })

  it('maps `multitouch-unavailable` to an actionable message', () => {
    const { tap, errors } = listener()
    tap.start()

    state.children[0].emit('{"error":"multitouch-unavailable"}')

    expect(errors).toEqual([
      'Система не отдаёт касания трекпада — жесты недоступны, работают горячие клавиши.'
    ])
  })

  it('passes an unknown error code through with a prefix', () => {
    const { tap, errors } = listener()
    tap.start()

    state.children[0].emit('{"error":"weird"}')

    expect(errors).toEqual(['Слушатель жестов: weird'])
  })

  it('clears the error on `ready`', () => {
    const { tap } = listener()
    tap.start()
    state.children[0].emit('{"error":"weird"}')

    state.children[0].emit('{"event":"ready"}')

    expect(tap.lastError).toBeNull()
  })

  it('logs the first line of stderr only', () => {
    const { tap } = listener()
    tap.start()

    state.children[0].emitStderr('first\nsecond\n')

    expect(console.warn).toHaveBeenCalledWith('[gesture] listener:', 'first')
  })

  it('ignores empty stderr', () => {
    const { tap } = listener()
    tap.start()

    state.children[0].emitStderr('  \n')

    expect(console.warn).not.toHaveBeenCalled()
  })
})

describe('TrackpadGestureListener: restart and stop', () => {
  it('restarts after a process that had reported ready', () => {
    const { tap } = listener()
    tap.start()
    state.children[0].emit('{"event":"ready"}')

    state.children[0].exit(0)

    expect(state.timers).toHaveLength(1)
    expect(state.timers[0].ms).toBe(1000)
    state.timers[0].fn()
    expect(state.children).toHaveLength(2)
    expect(tap.listening).toBe(true)
  })

  it('does not restart a process that never reported ready', () => {
    const { tap } = listener()
    tap.start()

    state.children[0].exit(1)

    expect(state.timers).toHaveLength(0)
  })

  it('reports a process error and schedules a restart', () => {
    const { tap, errors } = listener()
    tap.start()
    state.children[0].emit('{"event":"ready"}')

    state.children[0].fail(new Error('ENOENT'))

    expect(errors).toEqual(['ENOENT'])
    expect(state.timers).toHaveLength(1)
  })

  it('keeps restarting with a 1 s backoff forever (KNOWN BUG: characterization)', () => {
    // Same shape as `voice/listen.ts`: `ready` resets `failures`,
    // so the exponential growth and the six-failure cap are unreachable.
    const { tap } = listener()
    tap.start()
    const delays: number[] = []

    for (let attempt = 0; attempt < 8; attempt += 1) {
      const child = state.children[state.children.length - 1]
      child.emit('{"event":"ready"}')
      child.exit(0)
      delays.push(state.timers[state.timers.length - 1].ms)
      state.timers[state.timers.length - 1].fn()
    }

    expect(delays).toEqual([1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000])
    expect(state.children).toHaveLength(9)
    expect(tap.listening).toBe(true)
  })

  it('does nothing when the process exits after stop()', () => {
    const { tap } = listener()
    tap.start()
    state.children[0].emit('{"event":"ready"}')

    tap.stop()
    state.children[0].exit(0)

    expect(state.timers).toHaveLength(0)
  })

  it('stop() kills the process and clears a pending restart', () => {
    const { tap } = listener()
    tap.start()
    state.children[0].emit('{"event":"ready"}')
    state.children[0].exit(0)

    tap.stop()

    expect(state.timers[0].cleared).toBe(true)
    expect(tap.listening).toBe(false)
  })

  it('stop() is safe when nothing is running', () => {
    const { tap } = listener()

    expect(() => tap.stop()).not.toThrow()
    expect(tap.listening).toBe(false)
  })

  it('a restart timer that fires after stop() launches nothing', () => {
    const { tap } = listener()
    tap.start()
    state.children[0].emit('{"event":"ready"}')
    state.children[0].exit(0)

    tap.stop()
    state.timers[0].fn()

    expect(state.children).toHaveLength(1)
  })
})
