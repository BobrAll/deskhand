// Signs the packaged app with a stable local certificate.
//
// electron-builder is configured with `identity: null`, so it leaves the app
// unsigned. Doing the signing here keeps the identity in one place and makes
// the ad-hoc fallback explicit instead of silently using whatever certificate
// happens to be in the keychain.
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { signAsync } from '@electron/osx-sign'

const DEFAULT_IDENTITY = 'Deskhand Local Signing'

function identityExists(identity, keychain) {
  if (identity === '-') return true
  const args = ['find-identity', '-p', 'codesigning']
  if (keychain) args.push(keychain)
  try {
    const output = execFileSync('security', args, { encoding: 'utf8' })
    return output.includes(`"${identity}"`)
  } catch {
    return false
  }
}

export default async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return
  // Universal builds pack and hook each slice before merging. Signing those
  // intermediate apps is wasted work and the merge invalidates the signature.
  if (context.appOutDir.endsWith('-temp')) return

  const app = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  if (!existsSync(app)) return

  const identity = process.env.DESKHAND_SIGN_IDENTITY || DEFAULT_IDENTITY
  const keychain = process.env.DESKHAND_KEYCHAIN || undefined
  const stable = identityExists(identity, keychain)

  if (!stable) {
    if (process.env.DESKHAND_REQUIRE_SIGNING === '1') {
      throw new Error(
        `Не найден сертификат «${identity}». Запусти bash scripts/create-signing-cert.sh или задай DESKHAND_SIGN_IDENTITY.`
      )
    }
    console.warn(
      `[sign] сертификат «${identity}» не найден — подписываю ad-hoc. ` +
        'Разрешения Accessibility и Screen Recording будут слетать после каждого обновления.'
    )
  }

  await signAsync({
    app,
    identity: stable ? identity : '-',
    identityValidation: false,
    keychain,
    hardenedRuntime: false,
    optionsForFile: () => ({ hardenedRuntime: false, timestamp: 'none' })
  })

  execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' })
  console.log(`[sign] ${stable ? identity : 'ad-hoc'} -> ${app}`)
}
