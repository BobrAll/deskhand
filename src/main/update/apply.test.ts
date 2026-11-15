import { describe, expect, it } from 'vitest'

import { swapScript } from './apply'

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
