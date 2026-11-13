/**
 * The Silero wiring: a warm worker first, the one-shot renderer second.
 *
 * The fake child answers the way either Python script does, so this pins the
 * decision a user depends on — a worker that cannot start must still produce a
 * line through `batch_tts.py` — without the real interpreter or weights.
 */

import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  spawns: [] as string[][],
  workerAnswers: false
}))

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/deskhand-silero-test' }
}))

vi.mock('./pronounce', () => ({
  resolvePronunciations: async () => ({})
}))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    existsSync: () => true,
    readFileSync: () => 'v0.5.0\n'
  }
})

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    mkdir: async () => undefined,
    writeFile: async () => undefined,
    readFile: async () => Buffer.from('RIFF'),
    rm: async () => undefined
  }
})

vi.mock('node:child_process', () => ({
  spawn: (command: string, args: string[]): ChildProcess => {
    state.spawns.push([command, ...args])
    const worker = args[0].endsWith('worker_tts.py')
    const child = new EventEmitter() as ChildProcess
    const stdout = new PassThrough()
    child.stdin = {
      write: (chunk: string): boolean => {
        if (!worker) return true
        const request = JSON.parse(chunk) as { id: number }
        queueMicrotask(() => {
          if (!state.workerAnswers) {
            child.emit('error', new Error('python is missing'))
            return
          }
          stdout.write(`DESKHAND ${JSON.stringify({ id: request.id, ok: true })}\n`)
        })
        return true
      }
    } as ChildProcess['stdin']
    child.stdout = stdout
    child.stderr = new PassThrough()
    child.kill = () => true
    if (!worker) queueMicrotask(() => child.emit('close', 0))
    return child
  }
}))

beforeEach(() => {
  state.spawns = []
  state.workerAnswers = false
})

afterEach(async () => {
  const { stopSileroWorker } = await import('./silero')
  stopSileroWorker()
  vi.resetModules()
})

describe('Silero synthesis', () => {
  it('keeps the warm worker when it answers and never starts the one-shot', async () => {
    state.workerAnswers = true
    const { synthesizeSilero } = await import('./silero')

    const result = await synthesizeSilero('Готово.', 'xenia', {})

    expect(result.ok).toBe(true)
    expect(state.spawns).toHaveLength(1)
    expect(state.spawns[0][1]).toMatch(/worker_tts\.py$/)
  })

  it('renders with batch_tts.py when the worker cannot start', async () => {
    const { synthesizeSilero } = await import('./silero')

    const result = await synthesizeSilero('Готово.', 'xenia', {})

    expect(result.ok).toBe(true)
    expect(state.spawns).toHaveLength(2)
    expect(state.spawns[0][1]).toMatch(/worker_tts\.py$/)
    expect(state.spawns[1][1]).toMatch(/batch_tts\.py$/)
  })
})
