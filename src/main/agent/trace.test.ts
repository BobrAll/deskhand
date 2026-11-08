import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { flushTrace, timed, trace, traceTurn, traceWithin } from './trace'

const { getPath } = vi.hoisted(() => ({ getPath: vi.fn() }))
vi.mock('electron', () => ({ app: { getPath } }))

it('records concurrent turns with separate IDs and pairs overlapping spans', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'smart-cursor-trace-'))
  getPath.mockReturnValue(directory)
  vi.stubEnv('SMART_CURSOR_AGENT_TRACE', '1')
  try {
    await Promise.all(['first', 'second'].map((name) =>
      traceTurn({ name }, () => timed('work', async () => { trace('checkpoint') }))))
    await vi.waitFor(async () => {
      const raw = await readFile(join(directory, 'agent-trace.jsonl'), 'utf8')
      const events = raw.trim().split('\n').map((line) => JSON.parse(line))
      expect(events).toHaveLength(10)
      const starts = events.filter((event) => event.event === 'turn.start')
      expect(new Set(starts.map((event) => event.turn)).size).toBe(2)
      for (const start of starts) {
        const own = events.filter((event) => event.turn === start.turn)
        expect(own.map((event) => event.event)).toEqual([
          'turn.start', 'work.start', 'checkpoint', 'work.end', 'turn.end'
        ])
        expect(own[1].span).toBe(own[3].span)
        expect(own[3].durationMs).toBeGreaterThanOrEqual(0)
      }
    })
  } finally {
    vi.unstubAllEnvs()
    await rm(directory, { recursive: true, force: true })
  }
})

it('flushes the queued writes so a quitting process does not drop the last line', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'smart-cursor-trace-flush-'))
  getPath.mockReturnValue(directory)
  vi.stubEnv('SMART_CURSOR_AGENT_TRACE', '1')
  try {
    await traceTurn({ name: 'flush' }, async () => {
      trace('last', { reason: 'quit' })
      // No wait: the line is queued, and the point is that the flush alone is
      // enough to get it onto the disk before the process goes away.
      await flushTrace()
      const raw = await readFile(join(directory, 'agent-trace.jsonl'), 'utf8')
      expect(raw).toContain('"event":"last"')
      expect(raw).toContain('"reason":"quit"')
    })
  } finally {
    vi.unstubAllEnvs()
    await rm(directory, { recursive: true, force: true })
  }
})

it('opens a turn when there is none, so a run from an untraced path still records', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'smart-cursor-trace-within-'))
  getPath.mockReturnValue(directory)
  vi.stubEnv('SMART_CURSOR_AGENT_TRACE', '1')
  try {
    // Called outside any turn, which is how the agent controller reaches it
    // when a caller forgot to open one.
    await traceWithin({ source: 'test' }, async () => {
      trace('agent.start', { maxSteps: 3 })
    })
    // The turn's own end event is written after the work returns, so the flush
    // has to come after the turn closes.
    await flushTrace()
    const events = (await readFile(join(directory, 'agent-trace.jsonl'), 'utf8'))
      .trim().split('\n').map((line) => JSON.parse(line))
    expect(events.map((event) => event.event)).toEqual(['turn.start', 'agent.start', 'turn.end'])
    expect(events[1].turn).toBe(events[0].turn)
  } finally {
    vi.unstubAllEnvs()
    await rm(directory, { recursive: true, force: true })
  }
})

it('files a late callback under the turn that is open, not the one it came from', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'smart-cursor-trace-stale-'))
  getPath.mockReturnValue(directory)
  vi.stubEnv('SMART_CURSOR_AGENT_TRACE', '1')
  try {
    // The sidecar is spawned inside the first turn that asks for it, so the
    // socket under its stdout is an async resource created in that turn — and
    // every chunk it delivers afterwards, for every later request, arrives in
    // that closed turn's context. Without a guard the next run's steps were
    // filed under the turn that had already ended, and one pipeline appeared to
    // contain a second, later run: the same task doing its work twice.
    let releaseFirst: () => void = () => undefined
    const firstDone = traceTurn({ name: 'first' }, async () => {
      // Created here, in this turn, and never cleared: exactly the shape of the
      // sidecar's stdout listener.
      setTimeout(() => trace('agent.step', { step: 1 }), 120)
      await new Promise<void>((resolve) => { releaseFirst = resolve })
    })
    await traceTurn({ name: 'second' }, async () => {
      releaseFirst()
      // The stale timer fires while this turn is the only one open.
      await new Promise<void>((resolve) => setTimeout(resolve, 200))
    })
    await firstDone
    await flushTrace()
    const events = (await readFile(join(directory, 'agent-trace.jsonl'), 'utf8'))
      .trim().split('\n').map((line) => JSON.parse(line))
    const steps = events.filter((event) => event.event === 'agent.step')
    expect(steps).toHaveLength(1)
    const second = events.find((event) => event.event === 'turn.start' && event.name === 'second')
    expect(steps[0].turn).toBe(second?.turn)
  } finally {
    vi.unstubAllEnvs()
    await rm(directory, { recursive: true, force: true })
  }
})

it('reuses the enclosing turn instead of starting a second one', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'smart-cursor-trace-nested-'))
  getPath.mockReturnValue(directory)
  vi.stubEnv('SMART_CURSOR_AGENT_TRACE', '1')
  try {
    await traceTurn({ name: 'outer' }, async () => {
      await traceWithin({ source: 'inner' }, async () => {
        trace('agent.start')
        await flushTrace()
      })
    })
    const events = (await readFile(join(directory, 'agent-trace.jsonl'), 'utf8'))
      .trim().split('\n').map((line) => JSON.parse(line))
    // One turn, not two: a nested turn would split one run across two ids and
    // break every "how long did this run take" question.
    expect(new Set(events.map((event) => event.turn)).size).toBe(1)
    expect(events.filter((event) => event.event === 'turn.start')).toHaveLength(1)
  } finally {
    vi.unstubAllEnvs()
    await rm(directory, { recursive: true, force: true })
  }
})
