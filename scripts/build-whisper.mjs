// Builds the bundled `whisper-cli` from whisper.cpp sources.
//
// The app never needs a network connection at runtime for speech recognition:
// the binary and the model are local. But the binary is ~2–4 MB of C++ (plus the
// Metal backend), so it is built here instead of being committed as a mystery
// blob. Run this once after cloning, or after bumping WHISPER_CPP_VERSION:
//
//   npm run build:whisper
//
// The result is `resources/whisper-cli`, a universal (arm64 + x86_64) binary that
// only links Apple's own frameworks — no Homebrew dependency at runtime.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const WHISPER_CPP_VERSION = 'v1.7.4'
const ARCHS = ['arm64', 'x86_64']

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const out = join(root, 'resources', 'whisper-cli')

function run(command, args, options = {}) {
  return spawnSync(command, args, { encoding: 'utf8', stdio: 'pipe', ...options })
}

function fail(message) {
  throw new Error(message)
}

function main() {
  const workdir = mkdtempSync(join(tmpdir(), 'deskhand-whisper-'))
  const source = join(workdir, 'whisper.cpp')

  try {
    console.log(`[whisper] fetching whisper.cpp ${WHISPER_CPP_VERSION}…`)
    const clone = run('git', [
      'clone',
      '--depth',
      '1',
      '--branch',
      WHISPER_CPP_VERSION,
      'https://github.com/ggml-org/whisper.cpp.git',
      source
    ])
    if (clone.status !== 0) fail(`git clone failed: ${(clone.stderr || '').trim()}`)

    const built = []
    for (const arch of ARCHS) {
      const buildDir = join(workdir, `build-${arch}`)
      const arm = arch === 'arm64'
      console.log(`[whisper] building ${arch}…`)
      const configure = run('cmake', [
        '-S',
        source,
        '-B',
        buildDir,
        '-DCMAKE_BUILD_TYPE=Release',
        // Static libs: the shipped app must not depend on anything installed by brew.
        '-DBUILD_SHARED_LIBS=OFF',
        '-DWHISPER_BUILD_TESTS=OFF',
        '-DWHISPER_BUILD_SERVER=OFF',
        '-DWHISPER_BUILD_EXAMPLES=ON',
        // The same split as build-transcribe.mjs: Metal only where it is used.
        `-DGGML_METAL=${arm ? 'ON' : 'OFF'}`,
        '-DGGML_METAL_EMBED_LIBRARY=ON',
        '-DGGML_BLAS=OFF',
        '-DGGML_ACCELERATE=ON',
        // ggml probes the build machine, not the target. Native tuning is how
        // the arm64 slice gets its CPU kernels, but on an Apple Silicon host it
        // emits -mcpu=apple-m2, which clang rejects for the x86_64 slice.
        `-DGGML_NATIVE=${arm ? 'ON' : 'OFF'}`,
        // Baseline x86-64 keeps the Intel slice runnable on every supported Mac,
        // the same floor build-transcribe.mjs asks for with TRANSCRIBE_X86_CONSERVATIVE.
        ...(arm ? [] : ['-DGGML_AVX=OFF', '-DGGML_AVX2=OFF', '-DGGML_FMA=OFF', '-DGGML_F16C=OFF']),
        // A Homebrew libomp found at configure time would become a runtime
        // dependency and break the binary on a clean Mac.
        '-DGGML_OPENMP=OFF',
        '-DCMAKE_OSX_ARCHITECTURES=' + arch,
        '-DCMAKE_OSX_DEPLOYMENT_TARGET=11.0'
      ])
      if (configure.status !== 0) fail(`cmake configure (${arch}) failed: ${(configure.stderr || '').trim()}`)

      const build = run('cmake', ['--build', buildDir, '--config', 'Release', '-j', '8', '--target', 'whisper-cli'])
      if (build.status !== 0) fail(`cmake build (${arch}) failed: ${(build.stderr || '').trim()}`)

      const binary = join(buildDir, 'bin', 'whisper-cli')
      if (!existsSync(binary)) fail(`whisper-cli was not produced for ${arch}`)
      built.push(binary)
    }

    const lipo = run('lipo', ['-create', '-output', out, ...built])
    if (lipo.status !== 0) fail(`lipo failed: ${(lipo.stderr || '').trim()}`)

    // Ad-hoc signature: the app itself is unsigned in dev, and macOS refuses to
    // run arm64 binaries without any signature at all.
    const codesign = run('codesign', ['--force', '--sign', '-', out])
    if (codesign.status !== 0) fail(`codesign failed: ${(codesign.stderr || '').trim()}`)

    console.log('[whisper] built', out)
  } finally {
    rmSync(workdir, { recursive: true, force: true })
  }
}

try {
  main()
} catch (error) {
  console.error(`[whisper] ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
