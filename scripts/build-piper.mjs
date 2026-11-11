// Stage the local Piper runtime and Ruslan voice for both dev and macOS packaging.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const resources = fileURLToPath(new URL('../resources/', import.meta.url))
const output = join(resources, 'piper')
const voice = 'ru_RU-ruslan-medium.onnx'
const voiceUrl = 'https://huggingface.co/rhasspy/piper-voices/resolve/217ddc79818708b078d0d14a8fae9608b9d77141/ru/ru_RU/ruslan/medium'
const libraries = ['libespeak-ng.1.dylib', 'libpiper_phonemize.1.dylib', 'libonnxruntime.1.14.1.dylib']
const notices = {
  'Piper.txt': 'https://raw.githubusercontent.com/rhasspy/piper/38917ff/LICENSE.md',
  'Piper-phonemize.txt': 'https://raw.githubusercontent.com/rhasspy/piper-phonemize/2023.11.14-4/LICENSE.md',
  'eSpeak-NG.txt': 'https://raw.githubusercontent.com/espeak-ng/espeak-ng/1.52.0/COPYING',
  'ONNX-Runtime.txt': 'https://raw.githubusercontent.com/microsoft/onnxruntime/v1.14.1/LICENSE',
  'ONNX-ThirdPartyNotices.txt': 'https://raw.githubusercontent.com/microsoft/onnxruntime/v1.14.1/ThirdPartyNotices.txt',
  'Ruslan.md': `${voiceUrl}/MODEL_CARD`
}
const required = [
  'engine/piper', 'engine/espeak-ng-data/phondata',
  ...libraries.map((file) => `engine/${file}`),
  `voices/${voice}`, `voices/${voice}.json`,
  ...Object.keys(notices).map((file) => `licenses/${file}`)
]

function run(command, args) {
  execFileSync(command, args, { stdio: 'inherit' })
}

function download(url, destination, sha256) {
  run('curl', ['--fail', '--location', '--silent', '--show-error', '--retry', '2', '--max-time', '180', url, '-o', destination])
  if (sha256 && createHash('sha256').update(readFileSync(destination)).digest('hex') !== sha256) {
    throw new Error(`Unexpected SHA-256 for ${url}`)
  }
}

function preparePiper() {
  if (required.every((file) => existsSync(join(output, file)))) return
  mkdirSync(resources, { recursive: true })
  const work = mkdtempSync(join(resources, '.piper-build-'))
  const bundle = join(work, 'bundle')
  const engine = join(bundle, 'engine')
  const voices = join(bundle, 'voices')
  const licenses = join(bundle, 'licenses')
  try {
    for (const directory of [engine, voices, licenses]) mkdirSync(directory, { recursive: true })

    // Both macOS variants of this release contain the same Intel architecture.
    const engineArchive = join(work, 'engine.tar.gz')
    const libraryArchive = join(work, 'libraries.tar.gz')
    download('https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_macos_x64.tar.gz',
      engineArchive, 'ced85c0a3df13945b1e623b878a48fdc2854d5c485b4b67f62857cf551deaf8b')
    download('https://github.com/rhasspy/piper-phonemize/releases/download/2023.11.14-4/piper-phonemize_macos_x64.tar.gz',
      libraryArchive, '9ec6e300c0d012a663758bc45a097b47ee759761a3b91c7742de042af789d84b')
    for (const archive of [engineArchive, libraryArchive]) run('tar', ['-xzf', archive, '-C', work])

    copyFileSync(join(work, 'piper', 'piper'), join(engine, 'piper'))
    cpSync(join(work, 'piper', 'espeak-ng-data'), join(engine, 'espeak-ng-data'), { recursive: true })
    for (const file of libraries) copyFileSync(join(work, 'piper-phonemize', 'lib', file), join(engine, file))
    const binary = join(engine, 'piper')
    chmodSync(binary, 0o755)
    run('install_name_tool', ['-add_rpath', '@executable_path', binary])
    for (const file of ['piper', ...libraries]) run('codesign', ['--force', '--sign', '-', join(engine, file)])

    download(`${voiceUrl}/${voice}`, join(voices, voice), '72a5f88e0b20928064eb45d88e1daa21f8af62d18613580d32cbb4aed48dcf7f')
    download(`${voiceUrl}/${voice}.json`, join(voices, `${voice}.json`), '706a4fb17bc304abd07809b552deae615e64dcbffbfbd09854ba37ca59e88117')
    for (const [file, url] of Object.entries(notices)) download(url, join(licenses, file))

    rmSync(output, { recursive: true, force: true })
    renameSync(bundle, output)
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

if (process.platform === 'darwin') preparePiper()
