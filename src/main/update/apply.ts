/**
 * Installing a downloaded update: verify it, then swap the bundle from outside
 * the process.
 *
 * The running app cannot replace itself — macOS keeps the bundle mapped — so
 * `startSwap` spawns a detached bash script that waits for this process to die,
 * moves the bundles with a backup like `scripts/install.sh` does, and relaunches.
 * The verification mirrors the installer: the sha256 sidecar, `codesign
 * --verify` and the pinned leaf, except the pin here is the *running* app's own
 * certificate, which is what keeps Accessibility and Screen Recording grants
 * alive across the update.
 */

import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** The leaf hash from a codesign designated requirement, or null when ad-hoc. */
export async function readDesignatedLeaf(appPath: string): Promise<string | null> {
  let output = ''
  try {
    const result = await execFileAsync('codesign', ['-d', '-r-', appPath])
    output = `${result.stdout}${result.stderr}`
  } catch (error) {
    const failed = error as { stdout?: string; stderr?: string }
    output = `${failed.stdout ?? ''}${failed.stderr ?? ''}`
  }
  const match = /certificate leaf = H"([0-9a-fA-F]+)"/.exec(output)
  return match ? match[1].toLowerCase() : null
}

export async function fileSha256(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

/** Unpacks the zip with `ditto`, the only unpacker that preserves a bundle. */
export async function unpackZip(zipPath: string, destDir: string): Promise<void> {
  await execFileAsync('ditto', ['-x', '-k', zipPath, destDir])
}

/**
 * Decides whether the unpacked app may replace the running one.
 *
 * Throws with a Russian sentence the settings window shows verbatim.
 */
export async function verifyUpdateApp(newAppPath: string, installedAppPath: string | null): Promise<void> {
  try {
    await execFileAsync('codesign', ['--verify', '--deep', '--strict', newAppPath])
  } catch {
    throw new Error('Подпись обновления не прошла проверку. Скачай его заново.')
  }
  const newLeaf = await readDesignatedLeaf(newAppPath)
  if (!newLeaf) {
    throw new Error('Обновление не подписано. Скачай его заново.')
  }
  if (installedAppPath) {
    const installedLeaf = await readDesignatedLeaf(installedAppPath)
    if (installedLeaf && installedLeaf !== newLeaf) {
      throw new Error('Сертификат обновления не совпадает с установленным приложением.')
    }
  }
}

export interface SwapPaths {
  /** The verified `Deskhand.app` waiting in the cache. */
  stagedApp: string
  /** The bundle in /Applications that is running right now. */
  installedApp: string
  /** Where the old bundle hides while the new one moves in. */
  backupApp: string
  /** The script's own log, next to the staged app. */
  logFile: string
}

/**
 * The detached installer, as text.
 *
 * Polls for the app's PID instead of sleeping a guess: the quit path runs its
 * own async teardown and the swap must not start while the bundle is still
 * mapped. On any failure the backup moves back, so the worst outcome is the
 * version the user already had.
 */
export function swapScript(paths: SwapPaths, pid: number): string {
  const quote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`
  return [
    `exec >${quote(paths.logFile)} 2>&1`,
    `for _ in $(seq 1 100); do kill -0 ${pid} 2>/dev/null || break; sleep 0.2; done`,
    `kill -0 ${pid} 2>/dev/null && { echo 'app never quit'; exit 1; }`,
    `rm -rf ${quote(paths.backupApp)}`,
    `if [ -e ${quote(paths.installedApp)} ]; then`,
    `  mv ${quote(paths.installedApp)} ${quote(paths.backupApp)} || { echo 'backup failed'; exit 1; }`,
    'fi',
    `if ! mv ${quote(paths.stagedApp)} ${quote(paths.installedApp)}; then`,
    `  echo 'swap failed, restoring'`,
    `  [ -e ${quote(paths.backupApp)} ] && mv ${quote(paths.backupApp)} ${quote(paths.installedApp)}`,
    '  exit 1',
    'fi',
    `rm -rf ${quote(paths.backupApp)}`,
    `xattr -dr com.apple.quarantine ${quote(paths.installedApp)} 2>/dev/null || true`,
    `open ${quote(paths.installedApp)}`
  ].join('\n')
}

/** Runs the swap script detached; it outlives this process on purpose. */
export function startSwap(script: string): void {
  const child = spawn('/bin/bash', ['-c', script], { detached: true, stdio: 'ignore' })
  child.unref()
}
