import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { timed, trace, traceTurn } from './trace'

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
