import { createRequire } from 'node:module'
import type { BrowserWindow } from 'electron'
import { resourcePath } from '../paths'

type WindowBlur = {
  setBlur(handle: Buffer, radius: number): number
}

const loadAddon = createRequire(__filename)
let addon: WindowBlur | null | undefined

export function setWindowBlur(win: BrowserWindow, radius: number): void {
  if (process.platform !== 'darwin') return
  if (addon === undefined) {
    try {
      const path = resourcePath('deskhand-window-blur.node')
      addon = loadAddon(path) as WindowBlur
    } catch {
      addon = null
    }
  }

  const status = addon?.setBlur(win.getNativeWindowHandle(), radius)
  if (status !== undefined && status !== 0) {
    console.warn('[window blur] WindowServer returned', status)
  }
}
