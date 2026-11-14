import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ARTIFACTS,
  PIN_PLACEHOLDER,
  certificateLeaf,
  isPinned,
  pinInstaller,
  readSigningPin
} from './lib/release.mjs'

describe('release helpers', () => {
  it('reads the certificate leaf from a designated requirement', () => {
    expect(
      certificateLeaf('designated => identifier "com.bobr.deskhand" and certificate leaf = H"ABC123"')
    ).toBe('abc123')
  })

  it('does not treat an ad-hoc cdhash as a certificate', () => {
    expect(certificateLeaf('designated => cdhash H"abc123"')).toBeNull()
  })

  it('accepts only a pinned SHA-1', () => {
    expect(isPinned('a'.repeat(40))).toBe(true)
    expect(isPinned('a'.repeat(39))).toBe(false)
    expect(isPinned(PIN_PLACEHOLDER)).toBe(false)
    expect(isPinned('')).toBe(false)
  })

  it('replaces the installer placeholder with the pin', () => {
    expect(pinInstaller(`before ${PIN_PLACEHOLDER} after`, 'a'.repeat(40))).toBe(
      `before ${'a'.repeat(40)} after`
    )
  })

  it('rejects an installer without the placeholder', () => {
    expect(() => pinInstaller('no placeholder', 'a'.repeat(40))).toThrow()
  })

  it('names the exact artifacts the installer downloads', () => {
    expect(ARTIFACTS).toEqual(['Deskhand-universal.zip', 'Deskhand-universal.dmg'])
  })

  it('reads a pin from disk', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'deskhand-pin-'))
    try {
      const path = join(dir, 'signing.json')
      await writeFile(path, JSON.stringify({ certificate: 'Test', leaf: 'b'.repeat(40) }))
      await expect(readSigningPin(path)).resolves.toEqual({
        certificate: 'Test',
        leaf: 'b'.repeat(40)
      })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
