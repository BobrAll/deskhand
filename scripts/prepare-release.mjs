// Collects the files that belong to a release next to the electron-builder
// artifacts: the installer, SHA-256 files, and the certificate pin.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, readFile, writeFile } from 'node:fs/promises'
import { createReadStream, existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ARTIFACTS, certificateLeaf, isPinned, pinInstaller, readSigningPin } from './lib/release.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const release = join(root, 'release')
const installer = join(root, 'scripts', 'install.sh')
const target = join(release, 'install.sh')

async function sha256(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

for (const name of ARTIFACTS) {
  if (!existsSync(join(release, name))) {
    throw new Error(`В release нет ${name}. Собери universal-релиз: npm run dist.`)
  }
}

const appDir = ['mac-universal', 'mac-arm64', 'mac'].find((name) => existsSync(join(release, name, 'Deskhand.app')))
if (!appDir) {
  throw new Error('В release нет собранного приложения.')
}

const app = join(release, appDir, 'Deskhand.app')
const resources = join(app, 'Contents', 'Resources')
for (const name of ['deskhand-helper', 'whisper-cli', 'deskhand-agent', 'transcribe-cli']) {
  if (!existsSync(join(resources, name))) {
    throw new Error(`В приложении нет ${name}. Собери нативные бинарники: npm run build:native.`)
  }
}
if (!existsSync(join(resources, 'speech', 'gigaam-v3-e2e-rnnt-Q4_K_M.gguf'))) {
  throw new Error('В приложении нет модели распознавания. Запусти npm run build.')
}

const result = spawnSync('codesign', ['-d', '-r-', app], { encoding: 'utf8' })
if (result.status !== 0) {
  throw new Error('Не удалось проверить подпись приложения.')
}
const actualLeaf = certificateLeaf(`${result.stdout}${result.stderr}`)
const pin = await readSigningPin(join(root, 'scripts', 'signing.json'))
const pinnedLeaf = process.env.DESKHAND_SIGN_LEAF || pin.leaf

if (!actualLeaf) {
  if (process.env.DESKHAND_ALLOW_ADHOC !== '1') {
    throw new Error(
      'Сборка подписана ad-hoc: разрешения будут слетать после обновлений. ' +
        'Запусти npm run sign:cert или задай DESKHAND_ALLOW_ADHOC=1.'
    )
  }
  console.warn('[release] приложение подписано ad-hoc: разрешения будут слетать после обновлений.')
} else {
  if (!isPinned(pinnedLeaf)) {
    throw new Error(
      'Сертификат не закреплён. Запусти npm run sign:cert: он создаст сертификат ' +
        'и запишет отпечаток в scripts/signing.json.'
    )
  }
  if (actualLeaf !== pinnedLeaf.toLowerCase()) {
    throw new Error(
      `Сертификат сборки (${actualLeaf}) не совпадает с закреплённым (${pinnedLeaf}). ` +
        'Восстанови тот же сертификат или обнови пин осознанно.'
    )
  }
}

const installerText = await readFile(installer, 'utf8')
const releasedInstaller = actualLeaf ? pinInstaller(installerText, actualLeaf) : installerText

for (const name of ARTIFACTS) {
  const hash = await sha256(join(release, name))
  await writeFile(join(release, `${name}.sha256`), `${hash}  ${name}\n`)
  console.log(`[release] ${name}`)
}

await writeFile(target, releasedInstaller)
await chmod(target, 0o755)
console.log('[release] install.sh')
