// Formats and lints the files a commit is about to record.
//
// Only staged files are touched, so a three-line commit does not wait for the
// whole repository. The full gate — types, Prettier, both test suites and the
// Swift style — is `npm run check`; this hook exists to keep a style slip out of
// history, not to replace the gate.
//
// A formatter rewrites files, so the index is updated afterwards: the commit
// then contains what the hook checked, not the text from before the rewrite.
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const local = (name) => join(root, 'node_modules', '.bin', name)

function git(...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' })
}

/**
 * Runs a tool with its own output, and turns a non-zero status into a short
 * message instead of a stack trace: the reason is already on screen, and a
 * stack from `child_process` hides it.
 */
function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' })
  if (result.error) {
    console.error(`Не удалось запустить ${command}: ${result.error.message}`)
    process.exit(1)
  }
  return result.status ?? 1
}

function requireSucceeded(command, args, message) {
  const status = run(command, args)
  if (status !== 0) {
    console.error(message)
    process.exit(status)
  }
}

const staged = git('diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z').split('\0').filter(Boolean)

// Prettier ignores what `.prettierignore` names anyway; the explicit list keeps
// a vendored binary or a Swift file from reaching it at all.
const PRETTIER_HANDLED = /\.(ts|tsx|js|cjs|mjs|json|css|html|md|ya?ml)$/
const prettierFiles = staged.filter(
  (file) =>
    PRETTIER_HANDLED.test(file) &&
    !file.startsWith('native/') &&
    !file.startsWith('resources/') &&
    file !== 'package-lock.json'
)
const swiftFiles = staged.filter((file) => file.endsWith('.swift'))
const lintFiles = staged.filter((file) => file.startsWith('src/') && /\.(ts|tsx)$/.test(file))

if (prettierFiles.length > 0) {
  requireSucceeded(
    local('prettier'),
    ['--write', '--log-level', 'warn', ...prettierFiles],
    'Коммит остановлен: Prettier не смог отформатировать файлы.'
  )
}

// A machine without a Swift toolchain still commits TypeScript; Swift is
// formatted where it can be compiled.
if (swiftFiles.length > 0) {
  if (existsSync('/usr/bin/swift')) {
    requireSucceeded(
      'swift',
      ['format', '--in-place', '--configuration', join(root, 'native', 'deskhand', '.swift-format'), ...swiftFiles],
      'Коммит остановлен: swift format не смог отформатировать файлы.'
    )
  } else {
    console.log('swift format недоступен — Swift-файлы не проверены.')
  }
}

const rewritten = [...prettierFiles, ...swiftFiles]
if (rewritten.length > 0) {
  requireSucceeded('git', ['add', '--', ...rewritten], 'Коммит остановлен: не удалось обновить индекс.')
}

if (lintFiles.length > 0) {
  requireSucceeded(local('eslint'), lintFiles, 'Коммит остановлен: ESLint нашёл ошибки.')
}
