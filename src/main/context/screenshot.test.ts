import { beforeEach, describe, expect, it, vi } from 'vitest'
import { captureScreenshot } from './screenshot'

const capture = vi.hoisted(() => ({
  calls: [] as string[][],
  failWindow: false,
  failRectangle: false,
  failFullScreen: false
}))

vi.mock('node:child_process', () => ({
  execFile: (_command: string, args: string[], _options: unknown, callback: (error: Error | null) => void) => {
    capture.calls.push([...args])
    const fail = args.includes('-l')
      ? capture.failWindow
      : args.includes('-R')
        ? capture.failRectangle
        : capture.failFullScreen
    queueMicrotask(() => callback(fail ? new Error('capture refused') : null))
  }
}))

vi.mock('node:fs/promises', () => ({
  mkdtemp: async () => '/tmp/deskhand-shot-test',
  readFile: async () => Buffer.from('image'),
  rm: async () => undefined
}))

vi.mock('electron', () => {
  const image = {
    isEmpty: () => false,
    getSize: () => ({ width: 1440, height: 900 }),
    resize: () => image,
    toJPEG: () => Buffer.from('jpeg')
  }
  return {
    screen: {
      getCursorScreenPoint: () => ({ x: 0, y: 0 }),
      getDisplayNearestPoint: () => ({ bounds: { x: 0, y: 0, width: 1440, height: 900 } })
    },
    nativeImage: { createFromBuffer: () => image }
  }
})

const fullScreenCalls = (): string[][] => capture.calls.filter((args) => args[0] === '-x' && args.length === 2)

const options = { maxSide: 1440, quality: 80 }

beforeEach(() => {
  capture.calls = []
  capture.failWindow = false
  capture.failRectangle = false
  capture.failFullScreen = false
})

describe('captureScreenshot: the whole-screen fallback', () => {
  it('stays null when the window cannot be captured and the fallback is off', async () => {
    capture.failWindow = true

    const shot = await captureScreenshot({ windowId: 7, bounds: null, allowFullScreenFallback: false }, options)

    expect(shot).toBeNull()
    expect(fullScreenCalls()).toHaveLength(0)
  })

  it('stays null when the window rectangle cannot be captured either', async () => {
    capture.failWindow = true
    capture.failRectangle = true

    const shot = await captureScreenshot(
      {
        windowId: 7,
        bounds: { x: 0, y: 0, width: 800, height: 600 },
        allowFullScreenFallback: false
      },
      options
    )

    expect(shot).toBeNull()
    expect(fullScreenCalls()).toHaveLength(0)
  })

  it('still takes the whole screen by default', async () => {
    capture.failWindow = true

    const shot = await captureScreenshot({ windowId: 7, bounds: null }, options)

    expect(shot).not.toBeNull()
    expect(fullScreenCalls()).toHaveLength(1)
  })
})

describe('captureScreenshot: the rectangle the picture covers', () => {
  it('claims no area for a window whose bounds are unknown', async () => {
    // Returning the display here would measure every coordinate the model gives
    // against a rectangle the window image does not show.
    const shot = await captureScreenshot({ windowId: 7, bounds: null }, options)

    expect(shot).not.toBeNull()
    expect(shot?.area).toBeNull()
    expect(shot?.fullScreen).toBe(false)
  })

  it('uses the window bounds when they are known', async () => {
    // The fake image is 1440×900, so these bounds survive the aspect check.
    const shot = await captureScreenshot({ windowId: 7, bounds: { x: 10, y: 20, width: 1440, height: 900 } }, options)

    expect(shot?.area).toEqual({ x: 10, y: 20, width: 1440, height: 900 })
    expect(shot?.fullScreen).toBe(false)
  })

  it('still reports the display for a full-display capture', async () => {
    const shot = await captureScreenshot({ windowId: null, fullDisplay: true }, options)

    expect(shot?.area).toEqual({ x: 0, y: 0, width: 1440, height: 900 })
    expect(shot?.fullScreen).toBe(true)
  })
})
