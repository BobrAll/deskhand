// Points Git at the hooks committed in `.githooks/`.
//
// `npm install` runs this through the `prepare` lifecycle, so a fresh checkout
// and every worktree get the same pre-commit check without a manual step. An
// unpacked copy without `.git` has no hooks to install, so it reports that and
// exits clean instead of failing the install.
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))

if (!existsSync(`${root}.git`)) {
  console.log('Нет .git — устанавливать хуки некуда.')
  process.exit(0)
}

execFileSync('git', ['config', 'core.hooksPath', '.githooks'], { cwd: root, stdio: 'inherit' })
console.log('Git-хуки включены: .githooks.')
