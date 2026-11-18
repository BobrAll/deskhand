// Starts `electron-vite dev` from a clean slate.
//
// A crashed or forgotten run leaves two things behind: the Vite server and an
// Electron process holding the single-instance lock. The second is what makes
// the next `npm run dev` print "another copy is already running" and exit
// without a window, while the first makes Vite pick port 5174 and the renderer
// load a URL the main process does not know about. Both have to go before the
// launch, so this is one command instead of three.
//
// Two rules make the kill safe, and both were learned the hard way:
//
// - The process list comes from `ps`, not from `pgrep` or `lsof`. Those two ask
//   launchd's sysmond for it, and in a sandboxed shell the answer is "sysmond
//   service not found" — the kill then silently matches nothing and the script
//   reports a clean start that never happened.
// - A process is ours because its *executable* lives in this checkout, never
//   because the path appears somewhere in its command line. Matching the text
//   meant that `grep node_modules/electron/dist` in another terminal — or this
//   script's own parent shell — was killed on sight.
import { execFileSync, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')

/** Every live process as `{ pid, ppid, argv }`. */
function processes() {
  const out = execFileSync('ps', ['-Ao', 'pid=,ppid=,command='], { encoding: 'utf8' })
  return out
    .split('\n')
    .map((line) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line))
    .filter(Boolean)
    .map((match) => ({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      argv: match[3].trim().split(/\s+/)
    }))
}

/**
 * Whether `argv` is a process this script may stop.
 *
 * Electron and its helpers are the binary itself, so the first token is enough.
 * The dev server is `node` running a script from `node_modules`, which is why
 * the arguments are checked — but only against *this* checkout's `node_modules`,
 * so a `node` in another project is never touched.
 */
function isOurs(argv) {
  const [exe, ...args] = argv
  if (!exe) return false
  if (exe.startsWith(`${root}/node_modules/electron/dist/`)) return true
  if (exe === `${root}/resources/deskhand-agent`) return true
  return /(^|\/)node$/.test(exe) && args.some((arg) => arg.startsWith(`${root}/node_modules/`))
}

/** Pids to stop: ours, and neither this script nor any process above it. */
function stale() {
  const all = processes()
  const protectedPids = new Set([process.pid])
  for (let pid = process.ppid; pid > 1;) {
    protectedPids.add(pid)
    pid = all.find((entry) => entry.pid === pid)?.ppid ?? 0
  }
  return all.filter(({ pid, argv }) => !protectedPids.has(pid) && isOurs(argv)).map(({ pid }) => pid)
}

function stop(pids, signal) {
  for (const pid of pids) {
    try {
      process.kill(pid, signal)
    } catch {
      // Already gone between listing and killing: that is the desired state.
    }
  }
}

const found = stale()
const dryRun = process.argv.includes('--dry-run')

if (dryRun) {
  // `npm run dev:fresh -- --dry-run`: show the decision without acting on it.
  // Without this there is no way to check the match rule except by watching
  // what disappears, which is exactly the wrong way to learn it was too broad.
  const all = processes()
  const named = all.filter(({ pid }) => found.includes(pid))
  console.log(
    named.length === 0
      ? 'dev:fresh: nothing stale, a launch would go straight to `npm run dev`'
      : named.map(({ pid, argv }) => `would stop ${pid}: ${argv.join(' ').slice(0, 120)}`).join('\n')
  )
  process.exit(0)
}

if (found.length > 0) {
  stop(found, 'SIGTERM')
  // The single-instance lock is released as the process exits, not when the
  // signal is delivered. Launching into that gap is the race this waits out.
  await new Promise((resolve) => setTimeout(resolve, 900))

  // Electron does not always honour SIGTERM while a window is drawing, and a
  // survivor would abort the launch we are about to make.
  const left = stale()
  if (left.length > 0) {
    stop(left, 'SIGKILL')
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
}

const dev = spawn('npm', ['run', 'dev'], { cwd: root, stdio: 'inherit' })

// Ctrl+C has to reach the child, or the next run starts with a Vite server
// nobody is watching. `inherit` already forwards the terminal's signals to the
// process group; this only covers the case of the parent being killed directly.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => dev.kill(signal))
}

dev.on('exit', (code) => process.exit(code ?? 0))
