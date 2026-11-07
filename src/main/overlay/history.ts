import Store from 'electron-store'

interface SavedCommand {
  question: string
  bundleId: string | null
}

interface HistoryFile {
  command?: SavedCommand
  exchanges?: unknown
}

let store: Store<HistoryFile> | undefined
let command: SavedCommand | null | undefined

function historyStore(): Store<HistoryFile> {
  return store ??= new Store<HistoryFile>({
    name: 'conversation',
    configFileMode: 0o600,
    clearInvalidConfig: true
  })
}

function parseCommand(value: unknown): SavedCommand | null {
  if (!value || typeof value !== 'object') return null
  const { question, bundleId } = value as Partial<SavedCommand>
  if (typeof question !== 'string' || !question.trim()) return null
  if (bundleId !== null && typeof bundleId !== 'string') return null
  return { question, bundleId }
}

function write(next: SavedCommand | null): void {
  command = next
  try {
    historyStore().store = next ? { command: next } : {}
  } catch {
    console.warn('[conversation] unable to save previous command')
  }
}

function read(): SavedCommand | null {
  if (command !== undefined) return command
  try {
    const saved = historyStore().store
    command = parseCommand(saved.command)
    if ('exchanges' in saved) {
      const legacy = Array.isArray(saved.exchanges) ? saved.exchanges : []
      command ??= legacy.map(parseCommand).filter((entry) => entry !== null).at(-1) ?? null
      write(command)
    }
  } catch {
    console.warn('[conversation] unable to read previous command')
    command = null
  }
  return command
}

export function readPreviousCommand(excludedApps: string[]): string | undefined {
  const saved = read()
  if (!saved || (saved.bundleId && excludedApps.includes(saved.bundleId))) return undefined
  return saved.question
}

export function saveCommand(question: string, bundleId: string | null, excludedApps: string[]): void {
  if (bundleId && excludedApps.includes(bundleId)) return
  write({ question, bundleId })
}

export function applyHistorySettings(enabled: boolean, excludedApps: string[]): void {
  const saved = read()
  if (saved && (!enabled || (saved.bundleId && excludedApps.includes(saved.bundleId)))) write(null)
}
