import { describe, expect, it, vi } from 'vitest'
import { createRecordingMode } from './recording'

function mode(): {
  setRecording: (active: boolean) => void
  standDown: ReturnType<typeof vi.fn>
  restore: ReturnType<typeof vi.fn>
} {
  const standDown = vi.fn()
  const restore = vi.fn()
  return { setRecording: createRecordingMode({ standDown, restore }), standDown, restore }
}

describe('createRecordingMode', () => {
  it('stands the listeners down while recording and restores them after', () => {
    const { setRecording, standDown, restore } = mode()

    setRecording(true)
    expect(standDown).toHaveBeenCalledOnce()
    expect(restore).not.toHaveBeenCalled()

    setRecording(false)
    expect(restore).toHaveBeenCalledOnce()
  })

  it('restores once when the renderer disarms and the window then closes', () => {
    const { setRecording, standDown, restore } = mode()

    setRecording(true)
    setRecording(false) // the field ended the recording
    setRecording(false) // the settings window's closed hook

    expect(standDown).toHaveBeenCalledOnce()
    expect(restore).toHaveBeenCalledOnce()
  })

  it('restores once when the window closes while the field is still armed', () => {
    const { setRecording, standDown, restore } = mode()

    setRecording(true)
    setRecording(false) // only the settings window's closed hook runs

    expect(standDown).toHaveBeenCalledOnce()
    expect(restore).toHaveBeenCalledOnce()
  })

  it('ignores a repeated arm', () => {
    const { setRecording, standDown } = mode()

    setRecording(true)
    setRecording(true)

    expect(standDown).toHaveBeenCalledOnce()
  })

  it('can arm again after a restore', () => {
    const { setRecording, standDown, restore } = mode()

    setRecording(true)
    setRecording(false)
    setRecording(true)

    expect(standDown).toHaveBeenCalledTimes(2)
    expect(restore).toHaveBeenCalledOnce()
  })
})
