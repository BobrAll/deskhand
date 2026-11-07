// Build a self-contained universal transcribe-cli for local speech recognition.
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const version = 'v0.4.1'
const output = fileURLToPath(new URL('../resources/transcribe-cli', import.meta.url))
const licenses = fileURLToPath(new URL('../resources/transcribe-licenses', import.meta.url))
const work = mkdtempSync(join(tmpdir(), 'smartcursor-transcribe-build-'))
const source = process.argv[2] ?? join(work, 'source')

function run(command, args) {
  execFileSync(command, args, { stdio: 'inherit' })
}

try {
  if (!process.argv[2]) {
    run('git', [
      'clone', '--depth', '1', '--branch', version,
      'https://github.com/handy-computer/transcribe.cpp.git', source
    ])
  }
  const binaries = []
  for (const arch of ['arm64', 'x86_64']) {
    const build = join(work, arch)
    run('cmake', [
      '-S', source, '-B', build,
      '-DCMAKE_BUILD_TYPE=Release',
      '-DCMAKE_OSX_DEPLOYMENT_TARGET=11.0',
      `-DCMAKE_OSX_ARCHITECTURES=${arch}`,
      '-DTRANSCRIBE_BUILD_SHARED=OFF',
      '-DTRANSCRIBE_BUILD_TESTS=OFF',
      '-DTRANSCRIBE_BUILD_EXAMPLES=ON',
      `-DTRANSCRIBE_METAL=${arch === 'arm64' ? 'ON' : 'OFF'}`,
      '-DTRANSCRIBE_X86_CONSERVATIVE=ON',
      '-DGGML_NATIVE=OFF',
      '-DGGML_METAL_EMBED_LIBRARY=ON'
    ])
    run('cmake', ['--build', build, '--parallel', '8', '--target', 'transcribe-cli'])
    binaries.push(join(build, 'bin', 'transcribe-cli'))
  }
  run('lipo', ['-create', '-output', output, ...binaries])
  run('codesign', ['--force', '--sign', '-', output])
  mkdirSync(licenses, { recursive: true })
  for (const [file, name] of [
    ['LICENSE', 'transcribe.cpp'],
    ['ggml/LICENSE', 'ggml'],
    ['src/third_party/miniz/LICENSE', 'miniz'],
    ['src/third_party/silero_vad/LICENSE', 'silero-vad']
  ]) {
    copyFileSync(join(source, file), join(licenses, `${name}.txt`))
  }
} finally {
  rmSync(work, { recursive: true, force: true })
}
