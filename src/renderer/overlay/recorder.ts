/**
 * Microphone capture for push-to-talk.
 *
 * The recording lives in the renderer because that is where the microphone
 * permission and the audio graph are. whisper wants a very specific shape —
 * 16 kHz, mono, 16-bit PCM — so the samples are resampled and trimmed here and
 * the main process receives a finished WAV, not raw audio it would have to
 * process on the UI thread's behalf.
 *
 * Three details matter for the feel of hold-to-talk:
 *
 * - capture starts immediately on press and the level meter is driven from the
 *   same buffers, so the card reacts while the user is still speaking;
 * - the microphone and the audio context are opened ahead of the first press
 *   (`primeRecorder`), because opening them for the first time takes long enough
 *   that a phrase spoken at once would lose its beginning;
 * - the input stream is released on stop. A microphone that stays open after the
 *   turn puts the orange dot in the menu bar forever, which reads as "it is
 *   spying".
 */

/** whisper.cpp only accepts 16 kHz mono input. */
const TARGET_RATE = 16_000

/**
 * Ceiling on buffered audio, so a wedged key cannot exhaust memory.
 *
 * This is a memory guard, not the recording limit: how long a press may last is
 * `voice.maxDurationMs`, and the main process closes the turn at that value. The
 * two have to agree at the top end, or the tail of a long recording is dropped
 * here while the card says the recording is still running — hence the same
 * 10 minutes that `sanitizeVoice` allows the setting to reach. At the typical
 * 48 kHz mono that is 115 MB, which a wedged key cannot grow past.
 */
const MAX_RECORDING_MS = 10 * 60_000

/** Below this the recording is silence, not speech. */
const SILENCE_RMS = 0.0035

/**
 * Blocks of silence kept on each side of the speech.
 *
 * The first and last phoneme are quieter than the block that contains them, and
 * cutting at the loud block alone clips them.
 */
const TRIM_PAD_LEAD_BLOCKS = 5
const TRIM_PAD_TAIL_BLOCKS = 6

/** How far a quiet phrase moves the meter: it is a display, not a measurement. */
const LEVEL_GAIN = 6

/**
 * How long a warm-up may hold the microphone when the device never delivers a
 * block. Normally the first block arrives in about 80 ms and the stream is
 * released at once; this only bounds a wedged device.
 */
const WARM_TIMEOUT_MS = 400

/** The microphone every capture — warm-up included — is opened with. */
const MICROPHONE: MediaTrackConstraints = {
  // Getting whisper's format as early as possible: the further processing the
  // browser does, the more it "improves" the audio into something the model
  // was never trained on.
  channelCount: 1,
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true
}

interface RecordedAudio {
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
  const start = Math.max(0, (first - TRIM_PAD_LEAD_BLOCKS) * blockSize)
  const end = Math.min(samples.length, (last + TRIM_PAD_TAIL_BLOCKS) * blockSize)
  return samples.subarray(start, end)
}

/**
 * One audio context for the whole page.
 *
 * Creating a context is what brings the audio subsystem up — the renderer's
 * audio service, the output device, the resampler — and that work is paid once.
 * A context per turn made the *first* turn of a session pay it between the key
 * press and the first captured sample, which is exactly the syllable the user
 * heard as lost; every later turn found the subsystem already warm. Keeping one
 * context and closing only the nodes that touch the microphone gives every turn
 * the same start. The microphone itself is still released on stop: the orange
 * dot in the menu bar belongs to the input stream, not to the context.
 */
let sharedContext: AudioContext | null = null

function audioContext(): AudioContext {
  if (!sharedContext || sharedContext.state === 'closed') sharedContext = new AudioContext()
  return sharedContext
}

/**
 * Connects a stream to a muted output and reports every captured block.
 *
 * `createScriptProcessor` is deprecated, but it is the only API that works in
 * every Electron build without shipping a worklet bundle; the load is trivial.
 * The returned function detaches the nodes and leaves the context running.
 */
function openGraph(
  context: AudioContext,
  stream: MediaStream,
  onBlock: (block: Float32Array) => void
): () => void {
  const source = context.createMediaStreamSource(stream)
  const processor = context.createScriptProcessor(4096, 1, 1)
  processor.onaudioprocess = (event) => onBlock(event.inputBuffer.getChannelData(0))

  // A silent destination keeps the processor running; without a connection some
  // browsers optimise the node away and no samples ever arrive.
  const mute = context.createGain()
  mute.gain.value = 0
  source.connect(processor)
  processor.connect(mute)
  mute.connect(context.destination)

  return () => {
    processor.onaudioprocess = null
    try {
      source.disconnect()
      processor.disconnect()
      mute.disconnect()
    } catch {
      /* already disconnected */
    }
  }
}

/**
 * A microphone opened ahead of the first press, so it is not opened *during* it.
 *
 * On macOS the first `getUserMedia` of a process resolves the TCC decision,
 * brings up the input device and starts CoreAudio — hundreds of milliseconds in
 * which nothing is captured. That cost lands on whichever phrase comes first,
 * and a person who presses the key and starts talking immediately loses the
 * beginning of that phrase.
 *
 * The warm-up runs the same path a turn does — context, stream, one block
 * through a processor — and then releases the stream, because an idle microphone
 * is an orange dot in the menu bar. A failure is deliberately swallowed: the
 * press opens the microphone itself and reports the real reason there.
 */
let warming: Promise<void> | null = null

export function primeRecorder(): Promise<void> {
  if (!warming) {
    warming = warmUp().catch(() => {
      // Not cached: a device that was busy at launch must be tried again rather
      // than staying cold for the life of the window.
      warming = null
    })
  }
  return warming
}

async function warmUp(): Promise<void> {
  const context = audioContext()
  if (context.state !== 'running') await context.resume().catch(() => undefined)

  const stream = await navigator.mediaDevices.getUserMedia({ audio: MICROPHONE })
  try {
    let detach = (): void => undefined
    await new Promise<void>((resolve) => {
      let settled = false
      let timer: ReturnType<typeof setTimeout> | null = null
      const finish = (): void => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        detach()
        resolve()
      }
      timer = setTimeout(finish, WARM_TIMEOUT_MS)
      detach = openGraph(context, stream, finish)
    })
  } finally {
    for (const track of stream.getTracks()) track.stop()
  }
}

/**
 * Opens the microphone and starts buffering.
 *
 * Resolves with the handles rather than a promise of audio: the caller decides
 * when the turn ends, and it may end without any audio at all (Escape).
 */
export async function startRecording(maxDurationMs: number): Promise<RecorderHandles> {
  // A press that lands while the page is still warming the microphone waits for
  // that open instead of starting a second one: two `getUserMedia` calls at once
  // would have the second queue behind the first anyway, and the first turn is
  // the one that must not lose audio.
  if (warming) await warming

  const stream = await navigator.mediaDevices.getUserMedia({ audio: MICROPHONE })
  const context = audioContext()
  if (context.state !== 'running') await context.resume()

  // The resampler needs the real input rate; read it once, while the context is
  // certainly alive. The buffer budget is in input frames too: the processor
  // delivers at this rate, not at TARGET_RATE, which applies only after
  // resampling.
  const inputRate = context.sampleRate
  const chunks: Float32Array[] = []
  let buffered = 0
  const limit = Math.floor((inputRate * Math.min(maxDurationMs, MAX_RECORDING_MS)) / 1000)
  let lastLevel = 0

  const detach = openGraph(context, stream, (input) => {
    lastLevel = Math.min(1, rms(input) * LEVEL_GAIN)
    if (buffered >= limit) return
    const copy = new Float32Array(input)
    chunks.push(copy)
    buffered += copy.length
  })

  let closed = false
  const teardown = (): void => {
    if (closed) return
    closed = true
    detach()
    for (const track of stream.getTracks()) track.stop()
    // The context stays open on purpose: see `audioContext`. Closing it here
    // would tear the audio subsystem down again and the next press would pay the
    // same startup cost in the middle of the first word.
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
