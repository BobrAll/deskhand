import Store from 'electron-store'

/** The one command a freshly opened card is allowed to remember. */
interface LastCommand {
  question: string
  bundleId: string | null
}

interface HistoryFile {
  command?: LastCommand
  /** Older format: whole exchanges. Read once on load, then rewritten away. */
  exchanges?: unknown
}

let store: Store<HistoryFile> | undefined
let command: LastCommand | null | undefined

function historyStore(): Store<HistoryFile> {
  return (store ??= new Store<HistoryFile>({
    name: 'conversation',
    configFileMode: 0o600,
    clearInvalidConfig: true
  }))
}

function parseCommand(value: unknown): LastCommand | null {
  if (!value || typeof value !== 'object') return null
  const { question, bundleId } = value as Partial<LastCommand>
  if (typeof question !== 'string' || !question.trim()) return null
  if (bundleId !== null && typeof bundleId !== 'string') return null
  return { question, bundleId }
}

function writeCommand(next: LastCommand | null): void {
  command = next
  try {
    historyStore().store = next ? { command: next } : {}
  } catch {
    console.warn('[conversation] unable to save previous command')
  }
}

/**
 * Folds the old list of exchanges into the single command this module keeps: the
 * latest one that still has a question, without its answer.
 */
function migrateLegacyExchanges(saved: HistoryFile): LastCommand | null {
  const legacy = Array.isArray(saved.exchanges) ? saved.exchanges : []
  return (
    legacy
      .map(parseCommand)
      .filter((entry) => entry !== null)
      .at(-1) ?? null
  )
}

function readCommand(): LastCommand | null {
  if (command !== undefined) return command
  try {
    const saved = historyStore().store
    command = parseCommand(saved.command)
    if ('exchanges' in saved) {
      command ??= migrateLegacyExchanges(saved)
      writeCommand(command)
    }
  } catch {
    console.warn('[conversation] unable to read previous command')
    command = null
  }
  return command
}

export function readPreviousCommand(excludedApps: string[]): string | undefined {
  const saved = readCommand()
  if (!saved || (saved.bundleId && excludedApps.includes(saved.bundleId))) return undefined
  return saved.question
}

export function saveCommand(question: string, bundleId: string | null, excludedApps: string[]): void {
  if (bundleId && excludedApps.includes(bundleId)) return
  writeCommand({ question, bundleId })
}

export function applyHistorySettings(enabled: boolean, excludedApps: string[]): void {
  const saved = readCommand()
  if (saved && (!enabled || (saved.bundleId && excludedApps.includes(saved.bundleId)))) writeCommand(null)
}
