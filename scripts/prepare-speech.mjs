// Stage the default speech recognizer before starting or packaging Deskhand.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, existsSync } from 'node:fs'
import { mkdir, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const resources = fileURLToPath(new URL('../resources/', import.meta.url))
const speech = join(resources, 'speech')
const file = 'gigaam-v3-e2e-rnnt-Q4_K_M.gguf'
const revision = '3efd5b39882ceadca5570a8fb9fa1a2c801d6d6d'
const url = `https://huggingface.co/handy-computer/gigaam-v3-e2e-rnnt-gguf/resolve/${revision}/${file}`
const sha256 = '7d69952fb431a8d7800ed9910dc61fea37d8406bfe96d10bf24c8bd4b7c68623'

async function verified(path) {
  if (!existsSync(path)) return false
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex') === sha256
}

async function prepareModel() {
  const model = join(speech, file)
  if (await verified(model)) return
  await mkdir(speech, { recursive: true })
  const temporary = `${model}.${process.pid}.part`
  try {
    execFileSync(
      'curl',
      ['--fail', '--location', '--silent', '--show-error', '--retry', '2', '--max-time', '300', url, '-o', temporary],
      { stdio: 'inherit' }
    )
    if (!(await verified(temporary))) throw new Error(`Unexpected SHA-256 for ${url}`)
    await rename(temporary, model)
  } finally {
    await rm(temporary, { force: true })
  }
}

if (process.platform === 'darwin') {
  const required = [
    'transcribe-cli',
    ...['transcribe.cpp', 'ggml', 'miniz', 'silero-vad'].map((name) => `transcribe-licenses/${name}.txt`)
  ]
  if (required.some((path) => !existsSync(join(resources, path)))) {
    const build = fileURLToPath(new URL('./build-transcribe.mjs', import.meta.url))
    execFileSync(process.execPath, [build], { stdio: 'inherit' })
  }
  await prepareModel()
}
