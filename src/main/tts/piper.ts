import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { TtsResult } from '@shared/tts'
import { resourcePath } from '../paths'

const SYNTHESIS_TIMEOUT_MS = 20_000
const STDERR_TAIL_CHARS = 2000
const FIRST_LINE_CHARS = 300

export function piperBinary(): string | null {
  const binary = resourcePath('piper/engine/piper')
  return existsSync(binary) ? binary : null
}

export function piperModel(): string | null {
  const model = resourcePath('piper/voices/ru_RU-ruslan-medium.onnx')
  return existsSync(model) && existsSync(`${model}.json`) ? model : null
}

function firstLine(text: string): string {
  const line = text.split('\n').find((item) => item.trim())
  return line?.trim().slice(0, FIRST_LINE_CHARS) ?? ''
}

function runPiper(binary: string, model: string, text: string, output: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const directory = dirname(binary)
    const child = spawn(binary, ['--model', model, '--output_file', output], {
      cwd: directory,
      env: { ...process.env, ESPEAK_DATA_PATH: join(directory, 'espeak-ng-data') },
      stdio: ['pipe', 'ignore', 'pipe']
    })

    let stderr = ''
    let settled = false
    const settle = (error?: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) reject(error)
      else resolve()
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      settle(new Error('Piper не ответил вовремя.'))
    }, SYNTHESIS_TIMEOUT_MS)

    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-STDERR_TAIL_CHARS)
    })
    child.on('error', (error) => settle(error))
    child.on('close', (code) => {
      if (code === 0) settle()
      else settle(new Error(firstLine(stderr) || `Piper завершился с кодом ${code}.`))
    })
    child.stdin.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code !== 'EPIPE') settle(error)
    })
    child.stdin.end(text.replace(/\s*\r?\n\s*/g, ' '))
  })
}

/**
 * Speaks one line with the local engine.
 *
 * The WAV is written to a temporary file because that is the interface Piper
 * offers; it is removed before the result is returned. The audio itself is
 * cached by the caller, which owns the cache identity.
 */
export async function synthesizePiper(text: string, voicePath: string): Promise<TtsResult> {
  const binary = piperBinary()
  if (!binary) return { ok: false, message: 'В сборке нет движка Piper.' }

  let directory: string | undefined
  try {
    directory = await mkdtemp(join(tmpdir(), 'deskhand-piper-'))
    const output = join(directory, 'speech.wav')
    await runPiper(binary, voicePath, text, output)
    const audio = await readFile(output)
    if (audio.length === 0) return { ok: false, message: 'Piper вернул пустой файл.' }
    return { ok: true, audio: audio.toString('base64'), cached: false, mime: 'audio/wav' }
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : 'Piper не смог озвучить текст.'
    }
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true }).catch(() => undefined)
  }
}
