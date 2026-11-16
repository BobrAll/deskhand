/**
 * The update feed: one GitHub release and the arithmetic around it.
 *
 * The repository, the zip name and the `.sha256` sidecar are the same contract
 * `scripts/install.sh` and `scripts/lib/release.mjs` already publish to; this
 * module only reads it. Everything here is stateless — the flow lives in
 * `index.ts`.
 */

import { createWriteStream } from 'node:fs'
import { rename, rm } from 'node:fs/promises'
import { pipeline } from 'node:stream/promises'

/** Kept in sync with `REPOSITORY` in `scripts/install.sh`. */
export const RELEASE_REPO = 'BobrAll/deskhand'
/** Kept in sync with `ARTIFACTS` in `scripts/lib/release.mjs`. */
export const UPDATE_ZIP_NAME = 'Deskhand-universal.zip'
/** Kept in sync with the sidecar `install.sh` verifies with `shasum -c`. */
export const UPDATE_SHA_NAME = `${UPDATE_ZIP_NAME}.sha256`

const FEED_TIMEOUT_MS = 15_000
const DOWNLOAD_TIMEOUT_MS = 15 * 60_000
const PROGRESS_INTERVAL_MS = 250

export interface ReleaseInfo {
  version: string
  zipUrl: string
  shaUrl: string
  sizeBytes: number | null
}

/** Parses `x.y.z` (a leading `v` is fine) into numbers; junk becomes zeros. */
function versionParts(version: string): number[] {
  return version
    .replace(/^v/i, '')
    .split('.')
    .map((part) => Number.parseInt(part, 10) || 0)
}

/** Strictly newer by numeric major.minor.patch comparison. */
export function isNewerVersion(current: string, candidate: string): boolean {
  const a = versionParts(current)
  const b = versionParts(candidate)
  const length = Math.max(a.length, b.length)
  for (let i = 0; i < length; i += 1) {
    const left = a[i] ?? 0
    const right = b[i] ?? 0
    if (right > left) return true
    if (right < left) return false
  }
  return false
}

/**
 * Reads the GitHub `releases/latest` payload.
 *
 * Returns null for anything that is not a release carrying both the zip and
 * its checksum: a partial asset list is not a feed this app can update from,
 * and saying "no update" is safer than a download that cannot be verified.
 */
export function parseLatestRelease(payload: unknown): ReleaseInfo | null {
  if (typeof payload !== 'object' || payload === null) return null
  const release = payload as { tag_name?: unknown; assets?: unknown }
  if (typeof release.tag_name !== 'string' || !Array.isArray(release.assets)) return null
  const version = release.tag_name.replace(/^v/i, '')
  if (!/^\d+\.\d+/.test(version)) return null

  const assets = release.assets as unknown[]
  const asset = (name: string): { url: string; size: number | null } | null => {
    const found = assets.find(
      (item): item is { name: string; size?: unknown; browser_download_url?: unknown } =>
        typeof item === 'object' && item !== null && (item as { name?: unknown }).name === name
    )
    if (!found || typeof found.browser_download_url !== 'string') return null
    const size = typeof found.size === 'number' ? found.size : null
    return { url: found.browser_download_url, size }
  }

  const zip = asset(UPDATE_ZIP_NAME)
  const sha = asset(UPDATE_SHA_NAME)
  if (!zip || !sha) return null
  return { version, zipUrl: zip.url, shaUrl: sha.url, sizeBytes: zip.size }
}

/** The hex digest out of a `shasum -a 256` sidecar (`<hash>  <name>`). */
export function parseSha256(text: unknown): string | null {
  if (typeof text !== 'string') return null
  const match = /\b([0-9a-fA-F]{64})\b/.exec(text)
  return match ? match[1].toLowerCase() : null
}

export async function fetchLatestRelease(): Promise<ReleaseInfo | null> {
  const response = await fetch(`https://api.github.com/repos/${RELEASE_REPO}/releases/latest`, {
    headers: { accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(FEED_TIMEOUT_MS)
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return parseLatestRelease(await response.json())
}

export async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, { signal: AbortSignal.timeout(FEED_TIMEOUT_MS) })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return response.text()
}

/**
 * Downloads `url` into `dest` through a `.part` file, reporting 0..1 progress.
 *
 * The rename at the end is what makes an interrupted download harmless: only a
 * complete file ever appears under the final name, the same rule the voice
 * model downloads follow.
 */
export async function downloadToFile(url: string, dest: string, onProgress: (progress: number) => void): Promise<void> {
  const part = `${dest}.part`
  await rm(part, { force: true })
  const response = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) })
  if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`)
  const total = Number(response.headers.get('content-length') ?? 0)
  const reader = response.body.getReader()
  let received = 0
  let lastEmit = 0
  try {
    async function* chunks(): AsyncGenerator<Uint8Array> {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        received += value.byteLength
        const now = Date.now()
        if (total > 0 && now - lastEmit > PROGRESS_INTERVAL_MS) {
          lastEmit = now
          onProgress(received / total)
        }
        yield value
      }
    }
    await pipeline(chunks(), createWriteStream(part))
  } finally {
    reader.releaseLock()
  }
  if (total > 0 && received !== total) {
    await rm(part, { force: true })
    throw new Error('Файл скачался не полностью.')
  }
  onProgress(1)
  await rename(part, dest)
}
