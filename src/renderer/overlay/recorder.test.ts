import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * `recorder.ts` talks to the Web Audio API and the microphone, neither of which
 * exists in the node test environment. Both are faked here at the level the
 * module uses them, so the *sequence* — context, stream, one block — is what the
 * assertions see.
 */

interface AudioBlock {
  inputBuffer: { getChannelData(): Float32Array }
}

class FakeTrack {
  stop = vi.fn()
}

class FakeStream {
  constructor(private readonly tracks: FakeTrack[]) {}
  getTracks(): FakeTrack[] {
    return this.tracks
  }
}

class FakeNode {
  connect = vi.fn()
  disconnect = vi.fn()
}

class FakeProcessor extends FakeNode {
  onaudioprocess: ((event: AudioBlock) => void) | null = null
}

class FakeAudioContext {
  static created: FakeAudioContext[] = []
  state = 'suspended'
  sampleRate = 48_000
  destination = new FakeNode()
  processors: FakeProcessor[] = []

  constructor() {
    FakeAudioContext.created.push(this)
  }

  resume = vi.fn(async () => {
    this.state = 'running'
  })

  close = vi.fn(async () => {
    this.state = 'closed'
  })

  createMediaStreamSource = vi.fn(() => new FakeNode())

  createScriptProcessor = vi.fn(() => {
    const processor = new FakeProcessor()
    this.processors.push(processor)
    return processor
  })

  createGain = vi.fn(() => ({ gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() }))
}

let getUserMedia: ReturnType<typeof vi.fn>
let tracks: FakeTrack[]

/** Lets every pending promise (getUserMedia, the awaits around it) settle. */
async function flush(times = 20): Promise<void> {
  for (let i = 0; i < times; i += 1) await Promise.resolve()
}

/** One captured block; 4096 frames, the processor's own buffer size. */
const BLOCK_FRAMES = 4096

function block(value: number): AudioBlock {
  const samples = new Float32Array(BLOCK_FRAMES).fill(value)
  return { inputBuffer: { getChannelData: () => samples } }
}

beforeEach(() => {
  vi.resetModules()
  FakeAudioContext.created = []
  tracks = []
  getUserMedia = vi.fn(async () => {
    const track = new FakeTrack()
    tracks.push(track)
    return new FakeStream([track])
  })
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } })
  vi.stubGlobal('AudioContext', FakeAudioContext)
})

describe('microphone warm-up', () => {
  it('opens the microphone ahead of the press and releases it at once', async () => {
    const { primeRecorder } = await import('./recorder')

    const priming = primeRecorder()
    await flush()

    expect(getUserMedia).toHaveBeenCalledTimes(1)
    const context = FakeAudioContext.created[0]
    expect(context.resume).toHaveBeenCalled()

    // The first captured block is the signal that the device is actually
    // running; only then is the stream released.
    context.processors[0].onaudioprocess?.(block(0.5))
    await priming

    expect(tracks[0].stop).toHaveBeenCalled()
  })

  it('leaves the audio context open for the turn that follows', async () => {
    const { primeRecorder, startRecording } = await import('./recorder')

    const priming = primeRecorder()
    await flush()
    const context = FakeAudioContext.created[0]
    context.processors[0].onaudioprocess?.(block(0.5))
    await priming

    const recorder = await startRecording(30_000)
    expect(FakeAudioContext.created).toHaveLength(1)
    expect(getUserMedia).toHaveBeenCalledTimes(2)

    for (let i = 0; i < 3; i += 1) context.processors[1].onaudioprocess?.(block(0.5))
    const audio = await recorder.stop(true)

    expect(audio?.wavBase64.length).toBeGreaterThan(0)
    expect(tracks[1].stop).toHaveBeenCalled()
    // Closing the context here would make the next press pay the startup cost
    // again, in the middle of its first word.
    expect(context.close).not.toHaveBeenCalled()
  })

  it('makes a press during the warm-up wait for the same open', async () => {
    const { primeRecorder, startRecording } = await import('./recorder')

    const priming = primeRecorder()
    await flush()
    const recording = startRecording(30_000)
    await flush()

    // One microphone, not two: the turn joined the open that was already running.
    expect(getUserMedia).toHaveBeenCalledTimes(1)

    FakeAudioContext.created[0].processors[0].onaudioprocess?.(block(0.5))
    await priming
    const recorder = await recording

    expect(getUserMedia).toHaveBeenCalledTimes(2)
    await recorder.stop(false)
  })

  it('tries again on the next press when the warm-up failed', async () => {
    getUserMedia.mockRejectedValueOnce(new Error('device busy'))
    const { primeRecorder, startRecording } = await import('./recorder')

    // A failed warm-up is not a failed turn: the press opens the microphone
    // itself and reports the real reason there.
    await primeRecorder()

    const recorder = await startRecording(30_000)
    expect(getUserMedia).toHaveBeenCalledTimes(2)
    await recorder.stop(false)
  })

  it('releases the microphone when the turn captured nothing', async () => {
    const { startRecording } = await import('./recorder')

    const recorder = await startRecording(30_000)
    expect(await recorder.stop(false)).toBeNull()
    expect(tracks[0].stop).toHaveBeenCalled()
  })
})

describe('recording limit', () => {
  it('keeps the full window at the input rate and stops at its end', async () => {
    const { startRecording } = await import('./recorder')

    // The fake context runs at 48 kHz: a 2 s window is 96 000 input frames, not
    // the 32 000 that TARGET_RATE would allow.
    const recorder = await startRecording(2_000)
    const context = FakeAudioContext.created[0]

    // Three times the allowed audio: the buffer must stop at the window rather
    // than one third into it.
    for (let i = 0; i < 72; i += 1) context.processors[0].onaudioprocess?.(block(0.5))

    const audio = await recorder.stop(true)
    const blockMs = (BLOCK_FRAMES / context.sampleRate) * 1000
    expect(audio?.durationMs).toBeGreaterThanOrEqual(2_000)
    // A block that crosses the limit is kept whole; nothing after it is.
    expect(audio?.durationMs).toBeLessThanOrEqual(2_000 + blockMs)
  })
})
