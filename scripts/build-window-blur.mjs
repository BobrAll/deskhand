import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

if (process.platform !== 'darwin') process.exit(0)

const root = fileURLToPath(new URL('..', import.meta.url))
const resources = join(root, 'resources')
const nodeInclude = process.env.NODE_INCLUDE_DIR ??
  join(dirname(realpathSync(process.execPath)), '..', 'include', 'node')

if (!existsSync(join(nodeInclude, 'node_api.h'))) {
  console.warn('[window blur] Node headers unavailable. Set NODE_INCLUDE_DIR to build the native module.')
  process.exit(0)
}

mkdirSync(resources, { recursive: true })
const result = spawnSync('xcrun', [
  'clang', '-bundle', '-O2', '-fobjc-arc', '-undefined', 'dynamic_lookup',
  '-arch', 'arm64', '-arch', 'x86_64', '-mmacosx-version-min=11.0',
  '-framework', 'AppKit', '-I', nodeInclude,
  join(root, 'src/main/native/windowBlur.m'),
  '-o', join(resources, 'deskhand-window-blur.node')
], { stdio: 'inherit' })
process.exitCode = result.status ?? 1
