/**
 * Collects everything about the current application that is cheap to read:
 * the frontmost app and (optionally) its selected text.
 *
 * The screenshot is deliberately *not* taken here. Capturing belongs to the
 * overlay session (`overlay/index.ts`), which owns a *live* stream of captures:
 * the preview is refreshed while the card is open and a new picture is taken
 * right before every request. Taking it here would race with that and, worse,
 * would bake in a single frame from the moment the hotkey was pressed.
 */

import type { ContextFlags, ContextSnapshot } from '@shared/types'
import { getActiveApp, isExcluded } from './activeApp'
import { readSelection } from './selection'

export interface CollectOptions {
  /** Called once the synthetic ⌘C has been sent, before the pasteboard is read. */
  onCopySent?: () => void
  excludedApps: string[]
  /** Whether the user wants a screenshot when nothing is selected. */
  wantsScreenshot: boolean
}

export interface CollectResult {
  snapshot: ContextSnapshot
  /** What the overlay should have enabled/disabled on open. */
  flags: ContextFlags
}

const NO_FLAGS: ContextFlags = { includeSelection: false, includeScreenshot: false }

export async function collectContext(options: CollectOptions): Promise<CollectResult> {
  const startedAt = Date.now()
  const warnings: string[] = []

  const activeApp = await getActiveApp()
  if (!activeApp) warnings.push('Не удалось определить активное приложение.')
  const excluded = isExcluded(activeApp, options.excludedApps)
  if (excluded) warnings.push('Приложение входит в список исключений — контекст не собирается.')

  const selection = activeApp && !excluded ? await readSelection(options.onCopySent).catch(() => null) : null
  const screenshotWanted = Boolean(activeApp) && !excluded && options.wantsScreenshot

  // ТЗ §5.2: есть выделение -> по умолчанию только текст; нет выделения -> скриншот.
  const flags: ContextFlags = excluded
    ? { ...NO_FLAGS }
    : {
        includeSelection: Boolean(selection),
        includeScreenshot: screenshotWanted && !selection
      }

  const snapshot: ContextSnapshot = {
    activeApp,
    selection,
    screenshot: null,
    // The overlay fills this in once the live capture lands; starting with `true`
    // keeps the chip honest from the very first frame.
    screenshotPending: screenshotWanted,
    excluded,
    warnings,
    collectedMs: Date.now() - startedAt
  }

  return { snapshot, flags }
}
