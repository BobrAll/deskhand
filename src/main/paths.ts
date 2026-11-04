/** Resolves files shipped in `resources/` for both dev and packaged builds. */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'

export function resourcePath(name: string): string {
  const candidates = app.isPackaged
    ? [join(process.resourcesPath, name)]
    : [join(app.getAppPath(), 'resources', name), join(process.cwd(), 'resources', name)]
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]
}