// The helper contract, checked against the real binary.
//
// `src/main/native/helper.ts` parses JSON that only `smartcursor-helper` writes,
// and the tests for it use a mock. This script is the other half: it runs the
// shipped binary and asserts the shape of its answers, so a renamed key or a
// changed field type fails here instead of silently turning every answer into
// `null` at runtime.
//
// Only the read-only commands are exercised — `ping`, `permissions`, `front`,
// `apps`, `cursor`. Nothing here moves the mouse, presses a key, types, pastes,
// activates another app, records voice or asks for permissions: those are
// deliberately absent, see docs/refactor/RULES.md §"Безопасность среды".
//
// Not part of `npm test`: it needs macOS, the built binary and a real session.
// Run it with `npm run test:native`.
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const binary = join(root, 'resources', 'smartcursor-helper')

/** Commands this script is allowed to run, and why each one is safe. */
const READ_ONLY = [
  ['ping', 'writes one JSON object and exits'],
  ['permissions', 'reads the TCC state without prompting (request=false)'],
  ['front', 'reads the frontmost app and its window'],
  ['apps', 'lists Dock-visible apps'],
  ['cursor', 'reads the mouse position']
]

let failures = 0

function check(name, condition, detail) {
  if (condition) {
    console.log(`  ok   ${name}`)
    return
  }
  failures += 1
  console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
}

/** Runs one helper command and returns its parsed JSON, or null. */
function run(command) {
  const result = spawnSync(binary, [command], { encoding: 'utf8', timeout: 5000 })
  const raw = (result.stdout ?? '').trim()
  if (result.status !== 0) return { ok: false, raw, status: result.status, error: result.stderr ?? '' }
  try {
    return { ok: true, raw, json: JSON.parse(raw), status: result.status }
  } catch {
    return { ok: false, raw, status: result.status, error: 'stdout is not JSON' }
  }
}

if (process.platform !== 'darwin') {
  console.error('test:native requires macOS (the helper is an ObjC binary).')
  process.exit(1)
}

if (!existsSync(binary)) {
  console.error(`helper binary not found: ${binary}\nRun "npm run build:helper" first.`)
  process.exit(1)
}

console.log(`helper: ${binary}`)

// ---------------------------------------------------------------- the contract
//
// One JSON object per invocation, always with a boolean `ok`, and a non-zero exit
// only for a command the binary does not know. `runHelper` in helper.ts treats
// any non-zero exit as "no answer", so an unexpected code here means an answer
// that never reaches the app.
for (const [command, why] of READ_ONLY) {
  const result = run(command)
  console.log(`\n${command} (${why})`)
  check('exits 0', result.status === 0, `status ${result.status} ${result.error ?? ''}`)
  check('stdout is one JSON object', result.ok, result.error ?? result.raw.slice(0, 120))
  if (!result.ok) continue
  check('has a boolean "ok"', typeof result.json.ok === 'boolean')
  check('"ok" is true', result.json.ok === true, JSON.stringify(result.json).slice(0, 160))
}

// ------------------------------------------------------------------- per command
console.log('\nping')
{
  const { json } = run('ping')
  check('reports a version string', typeof json.version === 'string')
}

console.log('\npermissions')
{
  const { json } = run('permissions')
  check('accessibility is a boolean', typeof json.accessibility === 'boolean')
  check('screenRecording is a boolean', typeof json.screenRecording === 'boolean')
  // helper.ts reads exactly these two keys; the microphone is Electron's job.
  check('does not report a microphone', !('microphone' in json))
}

console.log('\nfront')
{
  const { json } = run('front')
  check('bundleId is a string', typeof json.bundleId === 'string')
  check('name is a string', typeof json.name === 'string')
  check('pid is a number', typeof json.pid === 'number')
  // KNOWN BUG: `front` prints `accessibility` as 1/0, not as a JSON boolean, so
  // `helperFront()`'s strict `payload.accessibility === true` is always false.
  // See docs/refactor/BUGS.md R3.
  check(
    'accessibility is a number 0/1 (known: not a boolean)',
    json.accessibility === 0 || json.accessibility === 1,
    String(json.accessibility)
  )
  if ('bounds' in json) {
    // KNOWN BUG: the bounds dictionary uses CGWindow keys (`X`, `Y`, `Width`,
    // `Height`), not the lowercase names `mapBounds` looks for. See BUGS.md R3.
    const bounds = json.bounds ?? {}
    const keys = Object.keys(bounds).sort()
    check(
      'bounds carries X/Y/Width/Height (known: capitalised)',
      ['Height', 'Width', 'X', 'Y'].every((key) => typeof bounds[key] === 'number'),
      keys.join(',')
    )
  }
  if ('title' in json) check('title is a string', typeof json.title === 'string')
}

console.log('\napps')
{
  const { json } = run('apps')
  check('apps is an array', Array.isArray(json.apps))
  const list = Array.isArray(json.apps) ? json.apps : []
  check('every entry has bundleId and name', list.every((app) => typeof app.bundleId === 'string' && typeof app.name === 'string'))
  // The list is the settings picker: it must not be empty on a normal desktop.
  check('is not empty', list.length > 0, `${list.length} apps`)
}

console.log('\ncursor')
{
  const { json } = run('cursor')
  check('x is a finite number', Number.isFinite(json.x))
  check('y is a finite number', Number.isFinite(json.y))
  check('scale is a positive number', typeof json.scale === 'number' && json.scale > 0)
  if (json.screen) {
    check(
      'screen carries x/y/width/height',
      ['x', 'y', 'width', 'height'].every((key) => typeof json.screen[key] === 'number')
    )
  }
}

// -------------------------------------------------------------- the error path
console.log('\nunknown command')
{
  const result = spawnSync(binary, ['definitely-not-a-command'], { encoding: 'utf8', timeout: 5000 })
  // Documented behaviour: the helper answers `unknown-command` and returns 1.
  check('exits non-zero', result.status !== 0, `status ${result.status}`)
  let json = null
  try {
    json = JSON.parse((result.stdout ?? '').trim())
  } catch {
    /* reported below */
  }
  check('still prints a JSON object', json !== null, (result.stdout ?? '').slice(0, 120))
  if (json) {
    check('ok is false', json.ok === false)
    check('names the error', json.error === 'unknown-command', String(json.error))
  }
}

console.log('')
if (failures > 0) {
  console.error(`${failures} check(s) failed`)
  process.exit(1)
}
console.log('helper contract holds')
