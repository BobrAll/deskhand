import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { swapScript, verifyUpdateApp } from './apply'

const PATHS = {
  stagedApp: '/Users/b/Library/Caches/deskhand-updates/0.2.0/unpacked/Deskhand.app',
  installedApp: '/Applications/Deskhand.app',
  backupApp: '/Applications/.Deskhand.app.old',
  logFile: '/Users/b/Library/Caches/deskhand-updates/0.2.0/swap.log'
}

describe('swapScript', () => {
  it('waits for the app to die before touching the bundle', () => {
    const script = swapScript(PATHS, 4242)
    const wait = script.indexOf('kill -0 4242')
    const firstMove = script.indexOf(`mv '${PATHS.installedApp}'`)
    expect(wait).toBeGreaterThanOrEqual(0)
    expect(firstMove).toBeGreaterThan(wait)
  })

  it('restores the backup when the swap fails', () => {
    const script = swapScript(PATHS, 1)
    expect(script).toContain(`mv '${PATHS.backupApp}' '${PATHS.installedApp}'`)
    expect(script).toContain('swap failed, restoring')
  })

  it('relaunches the new bundle and clears the quarantine flag', () => {
    const script = swapScript(PATHS, 1)
    expect(script).toContain(`xattr -dr com.apple.quarantine '${PATHS.installedApp}'`)
    expect(script.trimEnd().endsWith(`open '${PATHS.installedApp}'`)).toBe(true)
  })

  it('quotes a path with an apostrophe without breaking the script', () => {
    const quoted = swapScript({ ...PATHS, installedApp: "/Appli'cations/Deskhand.app" }, 1)
    expect(quoted).toContain(`'/Appli'\\''cations/Deskhand.app'`)
  })
})

/**
 * The script is generated text, and the only honest test of generated text is
 * running it. A throwaway directory tree and a stub `open` in PATH stand in for
 * /Applications and the Finder.
 */
function fixture(): {
  root: string
  installed: string
  staged: string
  backup: string
  log: string
  opened: string
  run: () => ReturnType<typeof spawnSync>
} {
  const root = mkdtempSync(join(tmpdir(), 'deskhand-swap-'))
  const bin = join(root, 'bin')
  mkdirSync(bin)
  const opened = join(root, 'opened.txt')
  writeFileSync(join(bin, 'open'), `#!/bin/sh\nprintf '%s\\n' "$1" >> '${opened}'\n`)
  chmodSync(join(bin, 'open'), 0o755)

  const installed = join(root, 'Applications', 'Deskhand.app')
  mkdirSync(installed, { recursive: true })
  writeFileSync(join(installed, 'old.txt'), 'old')

  const staged = join(root, 'cache', 'unpacked', 'Deskhand.app')
  mkdirSync(staged, { recursive: true })
  writeFileSync(join(staged, 'new.txt'), 'new')

  const backup = join(root, 'Applications', '.Deskhand.app.old')
  const log = join(root, 'swap.log')
  return {
    root,
    installed,
    staged,
    backup,
    log,
    opened,
    run: () =>
      spawnSync(
        '/bin/bash',
        ['-c', swapScript({ stagedApp: staged, installedApp: installed, backupApp: backup, logFile: log }, 999_999)],
        {
          env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }
        }
      )
  }
}

describe('swapScript on disk', () => {
  it('moves the staged bundle in, drops the backup and reopens it', () => {
    const tree = fixture()
    try {
      expect(tree.run().status).toBe(0)
      expect(existsSync(join(tree.installed, 'new.txt'))).toBe(true)
      expect(existsSync(join(tree.installed, 'old.txt'))).toBe(false)
      expect(existsSync(tree.backup)).toBe(false)
      expect(readFileSync(tree.opened, 'utf8').trim()).toBe(tree.installed)
    } finally {
      rmSync(tree.root, { recursive: true, force: true })
    }
  })

  it('puts the old bundle back and still opens something when the move fails', () => {
    const tree = fixture()
    try {
      rmSync(tree.staged, { recursive: true, force: true })
      expect(tree.run().status).toBe(1)
      expect(existsSync(join(tree.installed, 'old.txt'))).toBe(true)
      expect(existsSync(tree.backup)).toBe(false)
      expect(readFileSync(tree.opened, 'utf8').trim()).toBe(tree.installed)
    } finally {
      rmSync(tree.root, { recursive: true, force: true })
    }
  })
})

describe('verifyUpdateApp', () => {
  it('refuses a directory that is not a signed bundle, in Russian', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'deskhand-unsigned-'))
    try {
      await expect(verifyUpdateApp(dir, null)).rejects.toThrow('Подпись обновления не прошла проверку')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
