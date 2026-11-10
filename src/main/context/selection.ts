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

/** Ceiling for the text a Cmd+C round trip is allowed to bring back. */
export const MAX_SELECTED_TEXT_CHARS = 24_000

/** How long the pasteboard is polled after the synthetic ⌘C, and how often. */
const SELECTION_POLL_TIMEOUT_MS = 450
const SELECTION_POLL_INTERVAL_MS = 35

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
    const deadline = Date.now() + SELECTION_POLL_TIMEOUT_MS
    while (Date.now() < deadline) {
      await delay(SELECTION_POLL_INTERVAL_MS)
      const current = clipboard.readText()
      if (current) {
        captured = current
        break
      }
    }

    // Restore as early as possible: the copy has already been delivered.
    restoreClipboard(snapshot)

    if (!captured.trim()) return null
    return truncate(captured, MAX_SELECTED_TEXT_CHARS)
  })
}