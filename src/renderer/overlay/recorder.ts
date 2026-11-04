/**
 * Microphone capture for push-to-talk.
 *
 * The recording lives in the renderer because that is where the microphone
 * permission and the audio graph are. whisper wants a very specific shape —
 * 16 kHz, mono, 16-bit PCM — so the samples are resampled and trimmed here and
 * the main process receives a finished WAV, not raw audio it would have to
 * process on the UI thread's behalf.
 *
 * Two details matter for the feel of hold-to-talk:
 *
 * - capture starts immediately on press and the level meter is driven from the
 *   same buffers, so the card reacts while the user is still speaking;
 * - the graph is torn down on stop. A microphone that stays open after the turn
 *   puts the orange dot in the menu bar forever, which reads as "it is spying".
 */

/** whisper.cpp only accepts 16 kHz mono input. */
const TARGET_RATE = 16_000

/** Ceiling on buffered audio, so a wedged key cannot exhaust memory. */
const MAX_SECONDS = 120

/** Below this the recording is silence, not speech. */
const SILENCE_RMS = 0.0035

export interface RecordedAudio {
  /** 16 kHz mono 16-bit WAV, base64. */
  wavBase64: string
  durationMs: number
}

export interface RecorderHandles {
  stop(capture: boolean): Promise<RecordedAudio | null>
  /** 0..1 loudness of the most recent block. */
  level(): number
}

function encodeWav(samples: Float32Array, sampleRate: number): ArrayBuffer {
  const buffer = new ArrayBuffer(44 + samples.length * 2)
  const view = new DataView(buffer)

  const writeText = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i))
  }

  writeText(0, 'RIFF')
  view.setUint32(4, 36 + samples.length * 2, true)
  writeText(8, 'WAVE')
  writeText(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, 1, true) // mono
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  writeText(36, 'data')
  view.setUint32(40, samples.length * 2, true)

  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i]))
    view.setInt16(44 + i * 2, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true)
  }
  return buffer
}

function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  // `String.fromCharCode(...bytes)` blows the stack on long recordings, so the
  // bytes are chunked.
  let binary = ''
  const chunk = 0x8000
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk))
  }
  return btoa(binary)
}

/** Linear resampling to 16 kHz. Speech recognition does not need better. */
function resample(input: Float32Array, from: number, to: number): Float32Array {
  if (from === to) return input
  const ratio = from / to
  const length = Math.floor(input.length / ratio)
  const output = new Float32Array(length)
  for (let i = 0; i < length; i += 1) {
    const position = i * ratio
    const left = Math.floor(position)
    const right = Math.min(left + 1, input.length - 1)
    const weight = position - left
    output[i] = input[left] * (1 - weight) + input[right] * weight
  }
  return output
}

function rms(block: Float32Array): number {
  let sum = 0
  for (let i = 0; i < block.length; i += 1) sum += block[i] * block[i]
  return Math.sqrt(sum / Math.max(1, block.length))
}

/**
 * Drops the leading and trailing silence.
 *
 * Whisper hallucinates words ("Спасибо за просмотр", "Продолжение следует") on
 * silence, and a card that answers a phrase nobody said is alarming. Trimming to
 * the first and last audible block removes both the hallucination and the wait:
 * a 6-second recording of a 2-second phrase is transcribed as 2 seconds.
 */
function trimSilence(samples: Float32Array, rate: number): Float32Array {
  const blockSize = Math.floor(rate / 50) // 20 ms
  const blocks = Math.floor(samples.length / blockSize)
  if (blocks === 0) return samples

  let first = 0
  let last = blocks - 1
  const loud = (index: number): boolean =>
    rms(samples.subarray(index * blockSize, (index + 1) * blockSize)) > SILENCE_RMS

  while (first < blocks && !loud(first)) first += 1
  while (last > first && !loud(last)) last -= 1

  if (first >= blocks) return new Float32Array(0)
  // A little padding keeps the first and last phoneme from being clipped.
  const start = Math.max(0, (first - 5) * blockSize)
  const end = Math.min(samples.length, (last + 6) * blockSize)
  return samples.subarray(start, end)
}

/**
 * Opens the microphone and starts buffering.
 *
 * Resolves with the handles rather than a promise of audio: the caller decides
 * when the turn ends, and it may end without any audio at all (Escape).
 */
export async function startRecording(maxDurationMs: number): Promise<RecorderHandles> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      // Getting whisper's format as early as possible: the further processing the
      // browser does, the more it "improves" the audio into something the model
      // was never trained on.
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true
    }
  })

  const context = new AudioContext()
  await context.resume()
  const source = context.createMediaStreamSource(stream)
  // `createScriptProcessor` is deprecated, but it is the only API that works in
  // every Electron build without shipping a worklet bundle; the load is trivial.
  const processor = context.createScriptProcessor(4096, 1, 1)

  // Captured before teardown: `context.sampleRate` is unreadable once the audio
  // context is closed, and the resampler needs the real input rate.
  const inputRate = context.sampleRate
  const chunks: Float32Array[] = []
  let buffered = 0
  const limit = Math.floor((TARGET_RATE * Math.min(maxDurationMs, MAX_SECONDS * 1000)) / 1000)
  let lastLevel = 0

  processor.onaudioprocess = (event) => {
    const input = event.inputBuffer.getChannelData(0)
    lastLevel = Math.min(1, rms(input) * 6)
    if (buffered >= limit) return
    const copy = new Float32Array(input)
    chunks.push(copy)
    buffered += copy.length
  }

  // A silent destination keeps the processor running; without a connection some
  // browsers optimise the node away and no samples ever arrive.
  const mute = context.createGain()
  mute.gain.value = 0
  source.connect(processor)
  processor.connect(mute)
  mute.connect(context.destination)

  let closed = false
  const teardown = (): void => {
    if (closed) return
    closed = true
    processor.onaudioprocess = null
    try {
      source.disconnect()
      processor.disconnect()
      mute.disconnect()
    } catch {
      /* already disconnected */
    }
    for (const track of stream.getTracks()) track.stop()
    void context.close()
  }

  return {
    level: () => lastLevel,
    async stop(capture: boolean): Promise<RecordedAudio | null> {
      teardown()
      const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
      if (!capture || total === 0) return null

      const merged = new Float32Array(total)
      let offset = 0
      for (const chunk of chunks) {
        merged.set(chunk, offset)
        offset += chunk.length
      }

      const trimmed = trimSilence(resample(merged, inputRate, TARGET_RATE), TARGET_RATE)
      if (trimmed.length < TARGET_RATE * 0.2) {
        // Under 200 ms of actual sound: there is nothing for whisper to decode.
        return { wavBase64: '', durationMs: Math.round((total / inputRate) * 1000) }
      }
      const wav = encodeWav(trimmed, TARGET_RATE)
      return {
        wavBase64: toBase64(wav),
        durationMs: Math.round((trimmed.length / TARGET_RATE) * 1000)
      }
    }
  }
}
