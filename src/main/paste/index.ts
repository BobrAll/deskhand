/**
 * Inserting an answer into the source application (ТЗ §6).
 *
 * Order matters: bring the remembered app forward, wait until it really is
 * frontmost, put the answer on the pasteboard, synthesize Cmd+V, give the target
 * a moment to consume it, then restore the user's previous clipboard content.
 * "Replace selection" needs no separate path: pasting over a selection replaces
 * it in every macOS text control.
 */

import { clipboard } from 'electron'
import type { ActiveAppInfo, PasteResult } from '@shared/types'
import { helperActivate, helperFront, helperSendKey } from '../native/helper'
import { delay, waitFor } from '../util'
import { restoreClipboard, snapshotClipboard, withClipboard } from './clipboard'

export { copyText } from './clipboard'

/** Time the target app gets to read the pasteboard after Cmd+V. */
const PASTE_SETTLE_MS = 300

async function focusTarget(target: ActiveAppInfo | null): Promise<boolean> {
  if (!target) return false
  const activated = await helperActivate({ bundleId: target.bundleId, pid: target.pid })
  if (!activated) return false

  // Waiting for the app to actually become frontmost is what makes Cmd+V land in
  // the right window instead of in whatever had focus a moment ago.
  return waitFor(async () => {
    const front = await helperFront()
    if (!front) return false
    if (front.bundleId && front.bundleId === target.bundleId) return true
    return target.pid > 0 && front.pid === target.pid
  }, 1500, 50)
}

async function putOnClipboard(text: string): Promise<void> {
  await withClipboard(async () => {
    clipboard.writeText(text)
  })
}

export async function pasteAnswer(text: string, target: ActiveAppInfo | null): Promise<PasteResult> {
  const focused = await focusTarget(target)
  if (!focused) {
    await putOnClipboard(text)
    return {
      ok: false,
      copiedOnly: true,
      message: 'Не удалось вернуться в исходное приложение — ответ скопирован в буфер обмена.'
    }
  }

  const typed = await withClipboard(async () => {
    const snapshot = snapshotClipboard()
    clipboard.writeText(text)
    // Give the pasteboard a tick to publish the new content before Cmd+V.
    await delay(40)

    const sent = await helperSendKey('paste')
    if (!sent) {
      restoreClipboard(snapshot)
      return false
    }

    await delay(PASTE_SETTLE_MS)
    restoreClipboard(snapshot)
    return true
  })

  if (!typed) {
    await putOnClipboard(text)
    return {
      ok: false,
      copiedOnly: true,
      message: 'Вставка недоступна в этом поле — ответ скопирован в буфер обмена.'
    }
  }

  return { ok: true, copiedOnly: false }
}