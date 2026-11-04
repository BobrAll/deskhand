/**
 * Selected-text capture (ТЗ §5.1).
 *
 * The only app-agnostic way to read a foreign app's selection without walking
 * the Accessibility tree is to ask that app for it: synthesize Cmd+C, read the
 * pasteboard, then put the user's clipboard back exactly as it was.
 */

import { clipboard } from 'electron'
import type { SelectionInfo } from '@shared/types'
import { helperSendKey } from '../native/helper'
import { restoreClipboard, snapshotClipboard, withClipboard } from '../paste/clipboard'
import { delay, truncate } from '../util'

export const MAX_SELECTION_CHARS = 24_000

export function readSelection(onCopySent?: () => void): Promise<SelectionInfo | null> {
  return withClipboard(async () => {
    const snapshot = snapshotClipboard()

    // Clear first: when nothing is selected, Cmd+C leaves the pasteboard empty,
    // which makes "no selection" distinguishable from "unchanged text".
    clipboard.clear()

    const sent = await helperSendKey('copy')
    onCopySent?.()
    if (!sent) {
      restoreClipboard(snapshot)
      return null
    }

    let captured = ''
    const deadline = Date.now() + 450
    while (Date.now() < deadline) {
      await delay(35)
      const current = clipboard.readText()
      if (current) {
        captured = current
        break
      }
    }

    // Restore as early as possible: the copy has already been delivered.
    restoreClipboard(snapshot)

    if (!captured.trim()) return null
    return truncate(captured, MAX_SELECTION_CHARS)
  })
}