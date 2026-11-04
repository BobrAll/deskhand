// Compiles and runs the gesture classifier tests (scripts/gesture.test.c).
//
// The classifier is the one part of the trackpad feature that can be wrong
// without anyone noticing until a gesture does the wrong thing: a tap that never
// fires, a hold that fires twice, a swipe that opens the card. It is plain C with
// no framework dependency, so it can be exercised on every build.
import { spawnSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = join(root, 'scripts', 'gesture.test.c')
const dir = mkdtempSync(join(tmpdir(), 'smartcursor-gesture-'))
const binary = join(dir, 'gesture-test')

try {
  const build = spawnSync('clang', ['-O2', '-I', join(root, 'src', 'main', 'native'), source, '-o', binary], {
    encoding: 'utf8'
  })
  if (build.status !== 0) {
    console.error(build.stderr || 'gesture test failed to compile')
    process.exit(1)
  }
  const run = spawnSync(binary, [], { encoding: 'utf8' })
  process.stdout.write(run.stdout ?? '')
  process.stderr.write(run.stderr ?? '')
  process.exit(run.status ?? 1)
} finally {
  rmSync(dir, { recursive: true, force: true })
}
