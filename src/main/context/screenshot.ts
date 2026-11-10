/**
 * Screenshot capture for the assistant's context.
 *
 * Two shapes, one function:
 *
 * - **Display** (`fullDisplay: true`) — the whole screen under the cursor. This is
 *   what the overlay requests, because pointing at the menu bar, the Dock or a
 *   second app must be possible; it is also the frame the drawing layer is pinned
 *   over.
 * - **Window** (a `windowId` or the remembered bounds) — still supported for
 *   callers that only need the app in front.
 *
 * `screencapture -l <windowId>` grabs exactly one window regardless of what is on
 * top, which is what the ТЗ asks for. Electron's `desktopCapturer` can only
 * enumerate sources and would still need the user to pick one, so the native CLI
 * is the better fit here. When the window id is unavailable (helper binary
 * missing / no Automation rights) we crop the window bounds with `-R`, and only
 * as a last resort take a full-screen `-x` capture.
 *
 * Every call takes a *fresh* picture: the same function serves the preview shown
 * when the overlay opens and the capture re-taken right before a request is
 * sent, so the model sees the screen as it is now, not as it was minutes ago.
 * Our own overlay window never ends up in the image — see `setContentProtection`
 * in `windows.ts`, which keeps it out of every capture path, including the
 * full-screen fallback.
 */

import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { nativeImage, screen } from 'electron'
import type { ScreenRect, ScreenshotInfo } from '@shared/types'
import { delay } from '../util'

export interface CaptureTarget {
  windowId: number | null
  /** Window bounds in screen points; used for the `-R` crop fallback. */
  bounds?: { x: number; y: number; width: number; height: number } | null
  /**
   * Capture the whole display instead of one window. Required when the following
   * question is "где нажать?": the answer may live in another app, and a window
   * capture would show the model only a part of what the user actually sees.
   */
  fullDisplay?: boolean
}

/**
 * Where the image sits on the real screen, in *points*.
 *
 * A window capture covers the window rectangle; a display capture covers the
 * whole display the cursor is on. `null` only when Electron cannot answer, in
 * which case nothing is drawn rather than drawing something wrong.
 */
function areaFromBounds(bounds: NonNullable<CaptureTarget['bounds']>): ScreenRect {
  return {
    x: Math.round(bounds.x),
    y: Math.round(bounds.y),
    width: Math.round(bounds.width),
    height: Math.round(bounds.height)
  }
}

function resolveArea(target: CaptureTarget): { area: ScreenRect | null; fullScreen: boolean } {
  try {
    if (target.fullDisplay) return { area: displayUnderCursor(), fullScreen: true }
    if (target.bounds) {
      return { area: areaFromBounds(target.bounds), fullScreen: false }
    }
    return { area: displayUnderCursor(), fullScreen: true }
  } catch {
    return { area: null, fullScreen: target.bounds == null }
  }
}

/** Bounds of the display the mouse is on, in global points. */
function displayUnderCursor(): ScreenRect {
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  return {
    x: Math.round(display.bounds.x),
    y: Math.round(display.bounds.y),
    width: Math.round(display.bounds.width),
    height: Math.round(display.bounds.height)
  }
}

function run(command: string, args: string[], timeoutMs = 8000): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: timeoutMs }, (error) => {
      if (error) reject(error)
      else resolve()
    })
  })
}

/** Captures one window by CGWindow id, even when it is covered by other windows. */
async function captureWindow(windowId: number, file: string): Promise<boolean> {
  try {
    await run('screencapture', ['-x', '-o', '-l', String(windowId), file])
    return true
  } catch {
    return false
  }
}

/** Captures the screen area occupied by the window (used when `-l` is refused). */
async function captureRegion(bounds: NonNullable<CaptureTarget['bounds']>, file: string): Promise<boolean> {
  const width = Math.round(bounds.width)
  const height = Math.round(bounds.height)
  if (width < 2 || height < 2) return false
  const region = `${Math.round(bounds.x)},${Math.round(bounds.y)},${width},${height}`
  try {
    await run('screencapture', ['-x', '-o', '-R', region, file])
    return true
  } catch {
    return false
  }
}

/**
 * Grabs the screen region `area` (in points) with no window filtering, so the
 * image contains exactly what the user sees — menu bar, other apps, everything.
 * Used when the answer has to point at something *outside* the active window.
 */
async function captureArea(area: ScreenRect, file: string): Promise<boolean> {
  const width = Math.round(area.width)
  const height = Math.round(area.height)
  if (width < 2 || height < 2) return false
  const region = `${Math.round(area.x)},${Math.round(area.y)},${width},${height}`
  try {
    await run('screencapture', ['-x', '-R', region, file])
    return true
  } catch {
    return false
  }
}

async function captureFullScreen(file: string): Promise<boolean> {
  try {
    await run('screencapture', ['-x', file])
    return true
  } catch {
    return false
  }
}

/** Scales + re-encodes a raw screenshot into a compact JPEG data URL. */
function compress(
  buffer: Buffer,
  maxSide: number,
  quality: number,
  placement: { area: ScreenRect | null; fullScreen: boolean }
): ScreenshotInfo | null {
  const image = nativeImage.createFromBuffer(buffer)
  if (image.isEmpty()) return null
  const size = image.getSize()
  const longest = Math.max(size.width, size.height)
  const scaled =
    longest > maxSide
      ? image.resize({
          width: Math.round((size.width * maxSide) / longest),
          height: Math.round((size.height * maxSide) / longest),
          quality: 'good'
        })
      : image
  const finalSize = scaled.getSize()
  const jpeg = scaled.toJPEG(quality)
  return {
    dataUrl: `data:image/jpeg;base64,${jpeg.toString('base64')}`,
    width: finalSize.width,
    height: finalSize.height,
    bytes: jpeg.byteLength,
    capturedAt: Date.now(),
    area: placement.area,
    fullScreen: placement.fullScreen
  }
}

/**
 * Checks that the picture really covers the rectangle it claims to cover.
 *
 * `screencapture -R` clamps a region that runs off the display, and the
 * whole-screen fallback grabs whichever display macOS considers first — so a
 * capture can quietly be a different rectangle than `area` (a second display, a
 * region clipped at the bottom). Every coordinate the model returns is then
 * measured against a rectangle the image does not show, and the symptom is a
 * click that is off by exactly the size of the mistake.
 *
 * The aspect ratio is the cheap tell. When it does not match, `area` is dropped
 * rather than adjusted: without it the drawing and acting tools are not offered
 * at all, which is honest, instead of aiming every coordinate at a rectangle
 * nobody can verify.
 */
function verifyPlacement(shot: ScreenshotInfo): ScreenshotInfo {
  const area = shot.area
  if (!area || area.width < 2 || area.height < 2) return shot
  const expected = area.width / area.height
  const actual = shot.width / shot.height
  if (!Number.isFinite(actual) || Math.abs(actual - expected) / expected <= 0.02) return shot
  console.warn('[screenshot] capture does not match the recorded area; dropping coordinates', {
    area,
    image: [shot.width, shot.height]
  })
  return { ...shot, area: null }
}

/**
 * Captures the target window and returns a compressed screenshot.
 * Returns null when macOS refuses (missing Screen Recording permission).
 */
export async function captureScreenshot(
  target: CaptureTarget,
  options: { maxSide: number; quality: number }
): Promise<ScreenshotInfo | null> {
  const dir = await mkdtemp(join(tmpdir(), 'deskhand-shot-'))
  const file = join(dir, 'window.png')
  try {
    // Which of the fallbacks actually produced the image. It decides the
    // rectangle the picture covers, and every returned coordinate is measured
    // against that rectangle — a wrong `area` draws the arrow in the wrong place.
    let placement: { area: ScreenRect | null; fullScreen: boolean } | null = null
    if (target.fullDisplay) {
      // "Где нажать?" — the model has to see the whole screen, including the
      // menu bar and other windows, not just the app the user is typing in.
      const display = displayUnderCursor()
      if (await captureArea(display, file)) placement = { area: display, fullScreen: true }
    }
    if (!placement && target.windowId !== null) {
      if (await captureWindow(target.windowId, file)) placement = resolveArea(target)
    }
    // The window may have been closed since it was remembered: fall back to its
    // last known bounds before giving up and grabbing the whole screen.
    if (!placement && target.bounds) {
      if (await captureRegion(target.bounds, file)) {
        placement = { area: areaFromBounds(target.bounds), fullScreen: false }
      }
    }
    if (!placement) {
      if (await captureFullScreen(file)) placement = { area: displayUnderCursor(), fullScreen: true }
    }
    if (!placement) return null

    // screencapture writes the file asynchronously; poll briefly for content.
    let buffer: Buffer | null = null
    for (let attempt = 0; attempt < 12; attempt += 1) {
      try {
        const data = await readFile(file)
        if (data.byteLength > 0) {
          buffer = data
          break
        }
      } catch {
        /* not written yet */
      }
      await delay(40)
    }
    if (!buffer) return null
    const shot = compress(buffer, options.maxSide, options.quality, placement)
    return shot ? verifyPlacement(shot) : null
  } catch {
    return null
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
}

