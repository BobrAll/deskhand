// Copies the `cu-service` binary from the sibling computer-use project into
// resources/, where electron-builder picks it up as an extra resource.
//
// The service is what makes semantic actions possible: it resolves a control by
// role and name, activates it through the Accessibility API, and waits for the
// application to confirm the change. It is optional at runtime — without it the
// agent falls back to coordinate clicks — so a machine that cannot build it is
// not a broken build.
//
// The binary is built by the other project, not here: duplicating its Swift
// package would give two sources of truth for a protocol that has one.
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const output = join(root, 'resources', 'cu-service')
// A checkout next to this one is the normal case; the environment variable is
// for a build machine that keeps the two repositories somewhere else.
const source = process.env.SMART_CURSOR_CU_PROJECT
  ?? join(root, '..', 'computer-use')
const built = join(source, '.build', 'release', 'cu-service')
const debug = join(source, '.build', 'debug', 'cu-service')

if (!existsSync(join(source, 'Package.swift'))) {
  console.warn('[cu] no computer-use project at', source, '— semantic actions will fall back to clicks')
  process.exit(0)
}

if (!existsSync(built) && !existsSync(debug)) {
  console.log('[cu] building cu-service')
  try {
    execFileSync('swift', ['build', '-c', 'release', '--product', 'cu-service'], {
      cwd: source,
      stdio: 'inherit',
      env: {
        ...process.env,
        // The Swift compiler's sandbox cannot build its own manifest on this
        // machine; the other project documents the same workaround.
        TMPDIR: '/tmp',
        SWIFT_MODULECACHE_PATH: '/tmp/mc',
        CLANG_MODULE_CACHE_PATH: '/tmp/mc'
      }
    })
  } catch (error) {
    console.warn('[cu] build failed, semantic actions will fall back to clicks:', String(error).split('\n')[0])
    process.exit(0)
  }
}

const from = existsSync(built) ? built : debug
if (!existsSync(from)) {
  console.warn('[cu] cu-service was not produced; semantic actions will fall back to clicks')
  process.exit(0)
}

mkdirSync(join(root, 'resources'), { recursive: true })
copyFileSync(from, output)
console.log('[cu] copied', from, '->', output)
