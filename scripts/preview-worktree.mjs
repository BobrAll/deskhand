import { execFileSync, spawn } from 'node:child_process'
import { constants, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, unlinkSync, accessSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline/promises'
import { setTimeout } from 'node:timers/promises'

const root = fileURLToPath(new URL('..', import.meta.url))
const [targetArg, ...options] = process.argv.slice(2).filter((arg) => arg !== '--dry-run')
const dryRun = process.argv.includes('--dry-run')
const profile = join(homedir(), 'Library', 'Application Support', 'Deskhand')
const electron = 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' })
}

function worktrees() {
  return git(root, 'worktree', 'list', '--porcelain', '-z').split('\0\0').filter(Boolean).map((record) => {
    const fields = record.split('\0')
    return {
      path: fields[0].slice('worktree '.length),
      branch: fields.find((field) => field.startsWith('branch '))?.slice('branch refs/heads/'.length),
      head: fields.find((field) => field.startsWith('HEAD '))?.slice('HEAD '.length)
    }
  })
}

function label(tree) {
  return `${tree.branch ?? tree.head?.slice(0, 8) ?? 'bare'} · ${tree.path}`
}

async function selectTarget(trees) {
  if (targetArg) {
    const matches = trees.filter((tree) =>
      tree.path === resolve(targetArg) || tree.branch === targetArg ||
      (tree.head?.startsWith(targetArg) && /^[a-f0-9]{7,40}$/.test(targetArg)))
    if (matches.length === 1) return matches[0]
    throw new Error('Укажи однозначную ветку или путь к worktree.')
  }
  if (!process.stdin.isTTY) throw new Error('Передай ветку или путь к worktree.')
  trees.forEach((tree, index) => console.log(`${index + 1}. ${label(tree)}`))
  const prompt = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const target = trees[Number(await prompt.question('Какой worktree запустить? ')) - 1]
    if (!target) throw new Error('Выбери номер из списка.')
    return target
  } finally {
    prompt.close()
  }
}

function sameFile(left, right) {
  return existsSync(left) && existsSync(right) && readFileSync(left).equals(readFileSync(right))
}

function executable(path) {
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

function sameInputs(source, target, paths) {
  const tracked = (cwd) => git(cwd, 'ls-files', '-z', '--', ...paths)
  const files = tracked(source)
  return Boolean(files) && files === tracked(target) &&
    files.split('\0').filter(Boolean).every((file) => sameFile(join(source, file), join(target, file)))
}

const nativeResources = [
  { binary: 'deskhand-helper', build: 'build-helper', inputs: ['src/main/native/helper.m'] },
  { binary: 'deskhand-agent', build: 'build-agent', inputs: ['native/deskhand'] },
  { binary: 'transcribe-cli', build: 'build-transcribe', inputs: [], extra: ['transcribe.cpp', 'ggml', 'miniz', 'silero-vad'].map((name) => `transcribe-licenses/${name}.txt`) },
  { binary: 'whisper-cli', build: 'build-whisper', inputs: [] }
]

function copyResource(source, destination) {
  if (sameFile(source, destination)) return
  const directory = dirname(destination)
  mkdirSync(directory, { recursive: true })
  const temporary = mkdtempSync(join(directory, '.preview-'))
  try {
    const staged = join(temporary, 'resource')
    copyFileSync(source, staged, constants.COPYFILE_EXCL)
    renameSync(staged, destination)
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
}

function prepareResources(source, target, inspectOnly) {
  const resources = join(target, 'resources')
  for (const { binary, build, inputs, extra = [] } of nativeResources) {
    const output = join(resources, binary)
    const files = [binary, ...extra]
    const buildScript = `scripts/${build}.mjs`
    const reusable = sameInputs(source, target, [buildScript, ...inputs]) &&
      executable(join(source, 'resources', binary)) &&
      extra.every((file) => existsSync(join(source, 'resources', file)))
    if (reusable) {
      console.log(`${binary}: готовый файл из основного checkout`)
      if (inspectOnly || source === target) continue
      for (const file of files) {
        copyResource(join(source, 'resources', file), join(resources, file))
      }
    } else {
      console.log(`${binary}: сборка в выбранном worktree`)
      if (inspectOnly) continue
      execFileSync(process.execPath, [buildScript], { cwd: target, stdio: 'inherit' })
      if (!executable(output) || extra.some((file) => !existsSync(join(resources, file)))) throw new Error(`Сборка ${binary} не создала исполняемый файл.`)
    }
  }

  const model = 'resources/speech/gigaam-v3-e2e-rnnt-Q4_K_M.gguf'
  if (sameInputs(source, target, ['scripts/prepare-speech.mjs']) &&
      existsSync(join(source, model)) && !existsSync(join(target, model))) {
    console.log('Модель распознавания: готовый файл из основного checkout')
    if (!inspectOnly) {
      copyResource(join(source, model), join(target, model))
    }
  }
}

function lockOwner() {
  let lock
  try {
    lock = readlinkSync(join(profile, 'SingletonLock'))
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
  const pid = Number(lock.match(/-(\d+)$/)?.[1])
  if (pid > 1 && lock === `${execFileSync('hostname', { encoding: 'utf8' }).trim()}-${pid}`) return pid
  throw new Error('Не удалось определить локального владельца блокировки Deskhand.')
}

function processCommand(pid) {
  return execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' }).trim()
}

function lockProcess(pid) {
  try {
    return processCommand(pid)
  } catch (error) {
    if (error.status === 1 && !error.stderr?.length) return null
    throw error
  }
}

async function stopDeskhand(trees) {
  const pid = lockOwner()
  if (!pid) return
  const command = lockProcess(pid)
  if (!command) return
  const binaries = trees.map((tree) => join(tree.path, electron))
  const installed = /^\/(?:Applications|Users\/[^/]+\/Applications)\/Deskhand\.app\/Contents\/MacOS\/Deskhand(?: |$)/
  if (!binaries.some((binary) => command === binary || command.startsWith(`${binary} `)) && !installed.test(command)) {
    throw new Error(`Не удалось подтвердить, что блокировку держит Deskhand (PID ${pid}). Закрой приложение вручную.`)
  }
  console.log('Завершаю текущую копию Deskhand')
  for (const signal of ['SIGTERM', 'SIGKILL']) {
    if (lockOwner() !== pid || lockProcess(pid) !== command) return
    try {
      process.kill(pid, signal)
    } catch (error) {
      if (error.code === 'ESRCH') return
      throw error
    }
    for (let attempt = 0; attempt < 20; attempt++) {
      await setTimeout(100)
      if (lockOwner() !== pid || lockProcess(pid) !== command) return
    }
  }
  throw new Error('Deskhand всё ещё удерживает блокировку запуска.')
}

async function main() {
  if (options.length) throw new Error('Используй npm run worktree -- [ветка или путь] [--dry-run].')
  const trees = worktrees()
  const source = trees[0].path
  const target = (await selectTarget(trees)).path
  const modules = join(target, 'node_modules')
  const sharedModules = join(source, 'node_modules')
  const localModules = lstatSync(modules, { throwIfNoEntry: false })
  const useShared = !localModules || localModules.isSymbolicLink()

  if (useShared && !sameFile(join(source, 'package-lock.json'), join(target, 'package-lock.json'))) {
    throw new Error('Файлы package-lock.json различаются. Подготовь зависимости в выбранном worktree.')
  }
  if (!executable(join(useShared ? source : target, electron))) {
    throw new Error('В доступной папке node_modules нет рабочего Electron.')
  }
  if (localModules?.isSymbolicLink() && readlinkSync(modules) !== sharedModules) {
    throw new Error('В выбранном worktree уже есть ссылка node_modules на другую папку.')
  }

  console.log(`Предпросмотр: ${target}`)
  console.log(useShared ? 'Зависимости из основного checkout' : 'Зависимости выбранного worktree')
  prepareResources(source, target, dryRun)
  if (dryRun) return

  if (!localModules) symlinkSync(sharedModules, modules, 'dir')
  try {
    await stopDeskhand(trees)
    const child = spawn('npm', ['run', 'dev:fresh'], { cwd: target, stdio: 'inherit' })
    const forwardSignal = (signal) => child.kill(signal)
    process.on('SIGINT', forwardSignal)
    process.on('SIGTERM', forwardSignal)
    try {
      process.exitCode = await new Promise((resolveExit, reject) => {
        child.once('error', reject)
        child.once('exit', (code, signal) => resolveExit(code ?? (signal === 'SIGINT' ? 130 : 1)))
      })
    } finally {
      process.off('SIGINT', forwardSignal)
      process.off('SIGTERM', forwardSignal)
    }
  } finally {
    if (!localModules && lstatSync(modules, { throwIfNoEntry: false })?.isSymbolicLink() &&
        readlinkSync(modules) === sharedModules) unlinkSync(modules)
  }
}

main().catch((error) => {
  console.error(`[worktree] ${error.message}`)
  process.exitCode = 1
})
