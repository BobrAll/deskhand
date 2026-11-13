/**
 * The per-run trace has two modes, and the difference between them is privacy.
 *
 * Off is the default: the run still needs an id for the sidecar, but no file may
 * appear. On is a debugging tool, so it must keep writing what it always did.
 */

import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ root: '' }))

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => state.root,
    getPath: () => state.root
  }
}))

const { createRunTrace } = await import('./run-trace')

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

describe('createRunTrace', () => {
  it('returns a fresh id and writes nothing when detailed is off', async () => {
    const root = mkdtempSync(join(tmpdir(), 'deskhand-run-trace-'))
    state.root = root
    try {
      const trace = createRunTrace({ detailed: false })
      trace.record('start', { prompt: 'секрет', windowTitle: 'Личное' })
      await trace.close()

      expect(trace.id).toMatch(UUID)
      // A new run needs its own id even when nothing is written: it is the name
      // the sidecar traces under.
      expect(createRunTrace().id).not.toBe(trace.id)
      expect(readdirSync(root)).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('writes the run and its dialogue when detailed is on', async () => {
    const root = mkdtempSync(join(tmpdir(), 'deskhand-run-trace-'))
    state.root = root
    try {
      const trace = createRunTrace({ detailed: true })
      trace.record('start', { prompt: 'задача' })
      trace.record('model-request', { body: { messages: [] } })
      await trace.close()

      const [filename] = readdirSync(join(root, 'agent-runs'))
      const rows: Array<{ event: string }> = JSON.parse(
        readFileSync(join(root, 'agent-runs', filename), 'utf8')
      )
      expect(rows.map((row) => row.event)).toEqual(['start', 'model-request'])

      const dialogue: Array<{ event: string }> = JSON.parse(
        readFileSync(join(root, 'agent-dialogs', filename), 'utf8')
      )
      expect(dialogue.map((row) => row.event)).toEqual(['model-request'])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
