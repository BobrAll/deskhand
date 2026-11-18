import { beforeEach, expect, it, vi } from 'vitest'

const disk = vi.hoisted(() => ({ data: {} as Record<string, unknown> }))

vi.mock('electron-store', () => ({
  default: class {
    get store() {
      return structuredClone(disk.data)
    }
    set store(value: Record<string, unknown>) {
      disk.data = structuredClone(value)
    }
  }
}))

beforeEach(() => {
  vi.resetModules()
  disk.data = {}
})

const command = { bundleId: 'app', question: 'Открой вкладку' }

it('loads only the latest command after a restart', async () => {
  const { saveCommand } = await import('./history')
  saveCommand('Более ранний запрос', 'app', [])
  saveCommand(command.question, command.bundleId, [])

  vi.resetModules()
  const { readPreviousCommand } = await import('./history')
  expect(readPreviousCommand([])).toBe(command.question)
  expect(disk.data).toEqual({ command })
})

it('migrates older exchanges to the latest command without its answer', async () => {
  disk.data = {
    exchanges: [
      { ...command, question: 'Старый запрос', answer: 'Старый ответ' },
      { ...command, answer: 'Готово' }
    ]
  }
  const { readPreviousCommand } = await import('./history')
  expect(readPreviousCommand([])).toBe(command.question)
  expect(disk.data).toEqual({ command })
})

it.each([false, true])('clears the command when disabled or excluded (enabled: %s)', async (enabled) => {
  const { applyHistorySettings, readPreviousCommand, saveCommand } = await import('./history')
  saveCommand(command.question, command.bundleId, [])

  applyHistorySettings(enabled, enabled ? [command.bundleId] : [])
  expect(readPreviousCommand([])).toBeUndefined()
  expect(disk.data).toEqual({})
})
