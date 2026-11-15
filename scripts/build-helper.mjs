// Compiles the ObjC helper into resources/deskhand-helper.
// Runs as part of `npm run dev` / `npm run build`; failures are non-fatal because
// the main process falls back to osascript based implementations.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = join(root, 'src/main/native/helper.m')
const outDir = join(root, 'resources')
const out = join(outDir, 'deskhand-helper')

if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true })

// Universal binary: the shipped app is universal, so the helper must be too.
const args = [
  '-O2',
  '-fobjc-arc',
  '-arch',
  'arm64',
  '-arch',
  'x86_64',
  '-mmacosx-version-min=11.0',
  '-framework',
  'Cocoa',
  '-framework',
  'ApplicationServices',
  '-framework',
  'Carbon',
  source,
  '-o',
  out
]
const result = spawnSync('clang', args, { encoding: 'utf8' })

if (result.status === 0) {
  console.log('[helper] built', out)
} else {
  console.warn('[helper] build failed, falling back to osascript:', (result.stderr || '').trim().split('\n')[0])
  process.exitCode = 0
}
