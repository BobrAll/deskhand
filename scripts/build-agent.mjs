// Builds the vendored Swift agent and copies it into resources/, where
// electron-builder picks it up as an extra resource.
//
// The agent lives in `native/deskhand` and is part of this repository: it is the
// only thing that touches the accessibility tree, ScreenCaptureKit and CGEvent,
// so it is the one part of the assistant that cannot be TypeScript. It is built
// here rather than fetched, because a binary downloaded at build time is a binary
// nobody reviewed.
//
// Universal by default, like the helper and the whisper binary: the shipped app
// is universal, and an arm64-only agent inside an x86_64 build would make the
// whole feature vanish on Intel — not fail, vanish, because a missing binary
// reads as "agent mode is not available on this Mac". `AGENT_ARCH` builds one
// slice and skips the merge, which is what a quick local iteration wants.
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const project = join(root, 'native', 'deskhand')
const output = join(root, 'resources', 'deskhand-agent')

if (!existsSync(join(project, 'Package.swift'))) {
  console.error('[agent] native/deskhand is missing; the agent cannot be built')
  process.exit(1)
}

/** The Swift compiler's sandbox cannot build its own manifest on some machines,
 *  including this project's development one; pointing the module caches at /tmp
 *  is the documented workaround. */
const env = {
  ...process.env,
  TMPDIR: '/tmp',
  SWIFT_MODULECACHE_PATH: '/tmp/mc',
  CLANG_MODULE_CACHE_PATH: '/tmp/mc'
}

/**
 * Builds one slice and returns a copy of it.
 *
 * The copy is not a nicety: `swift build --arch` puts every slice in the *same*
 * `.build/out/Products/Release` directory, so the second build silently replaces
 * the first. Lipo then gets the same file twice and refuses, which is at least
 * loud — but copying immediately is what makes "build two slices" mean anything.
 */
function buildSlice(arch, work) {
  const args = ['build', '-c', 'release', '--product', 'deskhand-agent']
  if (arch) args.push('--arch', arch)
  console.log(`[agent] swift ${args.join(' ')}`)
  execFileSync('swift', args, { cwd: project, stdio: 'inherit', env })

  const dir = execFileSync('swift', [...args, '--show-bin-path'], {
    cwd: project, env, encoding: 'utf8'
  }).trim()
  const binary = join(dir, 'deskhand-agent')
  if (!existsSync(binary)) {
    throw new Error(`the build did not produce ${binary}`)
  }
  const copy = join(work, `deskhand-agent${arch ? `-${arch}` : ''}`)
  copyFileSync(binary, copy)
  return copy
}

const requested = process.env.AGENT_ARCH || null
mkdirSync(join(root, 'resources'), { recursive: true })
const work = mkdtempSync(join(tmpdir(), 'smartcursor-agent-build-'))

try {
  if (requested) {
    copyFileSync(buildSlice(requested, work), output)
  } else {
    const slices = ['arm64', 'x86_64'].map((arch) => buildSlice(arch, work))
    execFileSync('lipo', ['-create', '-output', output, ...slices], { stdio: 'inherit' })
  }
} catch (error) {
  // A cross-arch slice needs the matching SDK and toolchain; a developer without
  // them should still be able to run the app on their own machine, so the failure
  // says which switch to use rather than leaving a broken resource behind.
  console.error('[agent] build failed:', String(error).split('\n')[0])
  console.error("[agent] to build only this Mac's slice, run AGENT_ARCH=arm64 npm run build:agent")
  process.exit(1)
} finally {
  rmSync(work, { recursive: true, force: true })
}

console.log(`[agent] -> ${output} (${Math.round(statSync(output).size / 1024)} KB)`)
