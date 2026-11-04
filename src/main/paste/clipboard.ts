/**
 * One clipboard queue for the whole app.
 *
 * macOS has exactly one clipboard, so any code that temporarily overwrites it
 * (reading the user's selection, pasting an answer) has to be serialised, and
 * has to restore whatever was there before.
 */

import { clipboard, nativeImage } from 'electron'

export interface ClipboardSnapshot {
  text: string
  html: string
  rtf: string
  bookmark: { title: string; url: string } | null
  png: Buffer | null
}

let queue: Promise<unknown> = Promise.resolve()

/** Runs `task` after every previously queued clipboard task has settled. */
export function withClipboard<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task)
  queue = run.catch(() => undefined)
  return run
}

export function snapshotClipboard(): ClipboardSnapshot {
  const bookmark = clipboard.readBookmark()
  return {
    text: clipboard.readText(),
    html: clipboard.readHTML(),
    rtf: clipboard.readRTF(),
    bookmark: bookmark.url ? bookmark : null,
    png: clipboard.has('image/png') ? clipboard.readImage().toPNG() : null
  }
}

export function restoreClipboard(snapshot: ClipboardSnapshot): void {
  clipboard.clear()
  if (snapshot.png) {
    clipboard.writeImage(nativeImage.createFromBuffer(snapshot.png))
    return
  }
  if (snapshot.bookmark) {
    clipboard.writeBookmark(snapshot.bookmark.title, snapshot.bookmark.url)
    return
  }
  if (!snapshot.text && !snapshot.html && !snapshot.rtf) return
  clipboard.write({
    text: snapshot.text,
    html: snapshot.html || undefined,
    rtf: snapshot.rtf || undefined
  })
}

/** Copies without typing anything anywhere (the "Копировать" action). */
export function copyText(text: string): Promise<void> {
  return withClipboard(async () => {
    clipboard.writeText(text)
  })
}