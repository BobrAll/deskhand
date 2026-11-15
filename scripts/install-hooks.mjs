// Points Git at the hooks committed in `.githooks/`.
//
// `npm install` runs this through the `prepare` lifecycle, so a fresh checkout
// and every worktree get the same pre-commit check without a manual step. A
// hook install must never break an install: an unpacked copy, a read-only
// `.git`, or a missing `git` binary reports the reason and exits clean.
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const hooksPath = '.githooks'

if (!existsSync(`${root}.git`)) {
  console.log('Нет .git — устанавливать хуки некуда.')
  process.exit(0)
}

// The value is shared by every worktree, so replacing a hooks directory that
// someone else chose without a word would be a surprise.
function configuredHooksPath() {
  try {
    return execFileSync('git', ['config', '--get', 'core.hooksPath'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim()
  } catch {
    return ''
  }
}

const current = configuredHooksPath()
if (current && current !== hooksPath) {
  console.log(`Заменяю core.hooksPath: было ${current}, стало ${hooksPath}.`)
}

try {
  execFileSync('git', ['config', 'core.hooksPath', hooksPath], { cwd: root, stdio: 'inherit' })
  console.log('Git-хуки включены: .githooks.')
} catch {
  console.log('Git-хуки не включены: git недоступен или .git только для чтения.')
}
