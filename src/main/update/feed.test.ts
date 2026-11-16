import { describe, expect, it } from 'vitest'

import { isNewerVersion, parseLatestRelease, parseSha256, UPDATE_ZIP_NAME } from './feed'

/** A `releases/latest` payload shaped like GitHub's, minus everything unused. */
function releasePayload(tagName: string, assets: Array<{ name: string; size?: number }>): unknown {
  return {
    tag_name: tagName,
    assets: assets.map((asset) => ({
      name: asset.name,
      size: asset.size ?? 1000,
      browser_download_url: `https://example.test/${asset.name}`
    }))
  }
}

const BOTH_ASSETS = [{ name: UPDATE_ZIP_NAME, size: 155_189_248 }, { name: `${UPDATE_ZIP_NAME}.sha256` }]

describe('isNewerVersion', () => {
  it('compares numerically, not lexicographically', () => {
    expect(isNewerVersion('0.9.0', '0.10.0')).toBe(true)
    expect(isNewerVersion('0.10.0', '0.9.0')).toBe(false)
  })

  it('accepts a leading v and missing patch parts', () => {
    expect(isNewerVersion('0.1', 'v0.2.0')).toBe(true)
    expect(isNewerVersion('v1.2.3', '1.2.3')).toBe(false)
  })

  it('treats junk parts as zero instead of throwing', () => {
    expect(isNewerVersion('0.1.0', '0.beta.0')).toBe(false)
    expect(isNewerVersion('', '0.0.1')).toBe(true)
  })
})

describe('parseLatestRelease', () => {
  it('reads version, urls and size from a complete release', () => {
    const parsed = parseLatestRelease(releasePayload('v0.2.0', BOTH_ASSETS))
    expect(parsed).toEqual({
      version: '0.2.0',
      zipUrl: `https://example.test/${UPDATE_ZIP_NAME}`,
      shaUrl: `https://example.test/${UPDATE_ZIP_NAME}.sha256`,
      sizeBytes: 155_189_248
    })
  })

  it('refuses a release without the checksum asset', () => {
    const parsed = parseLatestRelease(releasePayload('v0.2.0', [{ name: UPDATE_ZIP_NAME }]))
    expect(parsed).toBeNull()
  })

  it('refuses payloads that are not releases', () => {
    expect(parseLatestRelease(null)).toBeNull()
    expect(parseLatestRelease('0.2.0')).toBeNull()
    expect(parseLatestRelease({ tag_name: 'nightly', assets: [] })).toBeNull()
    expect(parseLatestRelease({ assets: BOTH_ASSETS })).toBeNull()
  })
})

describe('parseSha256', () => {
  it('reads the digest out of a shasum sidecar line', () => {
    const line = '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824  Deskhand-universal.zip\n'
    expect(parseSha256(line)).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824')
  })

  it('lowercases and refuses short or missing digests', () => {
    expect(parseSha256('ABCDEF' + '0'.repeat(58) + '  file')).toBe('abcdef' + '0'.repeat(58))
    expect(parseSha256('not a digest')).toBeNull()
    expect(parseSha256(42)).toBeNull()
  })
})
