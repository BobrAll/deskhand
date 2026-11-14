// Pins the certificate used by release builds.
//
// The pin is the certificate's SHA-1 leaf, the same value codesign prints in
// the app's designated requirement. Committing it makes a release built with a
// different key fail instead of silently resetting every user's TCC grants.
import { execFileSync } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isPinned } from './lib/release.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const pinPath = process.env.DESKHAND_SIGN_PIN_PATH || join(root, 'scripts', 'signing.json')
const certificate = process.env.DESKHAND_SIGN_IDENTITY || 'Deskhand Local Signing'
const keychain = process.env.DESKHAND_KEYCHAIN
const args = ['find-identity', '-p', 'codesigning']
if (keychain) args.push(keychain)

const output = execFileSync('security', args, { encoding: 'utf8' })
const line = output.split('\n').find((entry) => entry.includes(`"${certificate}"`))
const match = line ? /^\s*\d+\)\s+([0-9a-f]{40})\s+"/i.exec(line) : null
if (!match) {
  throw new Error(`Не найден сертификат «${certificate}». Сначала запусти npm run sign:cert.`)
}

const leaf = match[1].toLowerCase()
let previous = ''
try {
  previous = JSON.parse(await readFile(pinPath, 'utf8')).leaf
} catch {
  previous = ''
}
if (isPinned(previous) && previous !== leaf && process.env.DESKHAND_REPIN !== '1') {
  throw new Error(
    `В ${pinPath} уже закреплён другой сертификат (${previous}). ` +
      'Восстанови старый сертификат или задай DESKHAND_REPIN=1, если меняешь его осознанно.'
  )
}

await writeFile(pinPath, `${JSON.stringify({ certificate, leaf }, null, 2)}\n`)
console.log(`[sign] закреплён ${leaf}`)
