import { readFile } from 'node:fs/promises'

export const ARTIFACTS = ['Deskhand-universal.zip', 'Deskhand-universal.dmg']
export const PIN_PLACEHOLDER = '__DESKHAND_SIGNING_LEAF__'

/** The leaf hash from a codesign designated requirement, or null for ad-hoc. */
export function certificateLeaf(requirement) {
  const match = /certificate leaf = H"([0-9a-f]+)"/i.exec(requirement)
  return match ? match[1].toLowerCase() : null
}

/** A pinned leaf is a SHA-1, written by scripts/pin-signing-cert.mjs. */
export function isPinned(leaf) {
  return typeof leaf === 'string' && /^[0-9a-f]{40}$/i.test(leaf)
}

/** Replaces the installer's placeholder with the pinned leaf. */
export function pinInstaller(text, leaf) {
  if (!text.includes(PIN_PLACEHOLDER)) {
    throw new Error('В scripts/install.sh нет места для отпечатка сертификата.')
  }
  return text.replaceAll(PIN_PLACEHOLDER, leaf)
}

export async function readSigningPin(path) {
  const data = JSON.parse(await readFile(path, 'utf8'))
  return { certificate: data.certificate, leaf: data.leaf }
}
