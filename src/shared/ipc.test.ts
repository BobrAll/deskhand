import { describe, expect, it } from 'vitest'

import { CH } from './ipc'

/** Flattens the nested `CH` map into `path -> channel` pairs. */
function flatten(node: unknown, prefix = ''): Array<[string, string]> {
  const out: Array<[string, string]> = []
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${key}` : key
    if (typeof value === 'string') out.push([path, value])
    else out.push(...flatten(value, path))
  }
  return out
}

const channels = flatten(CH)

describe('CH (smoke)', () => {
  it('exposes a non-empty map of namespaced channel names', () => {
    expect(channels.length).toBeGreaterThan(0)
    for (const [path, channel] of channels) {
      expect(channel, path).toMatch(/^[a-z][a-z0-9-]*:[a-z][a-z0-9-]*$/)
    }
  })
})

/**
 * The channel set is a wire protocol: main, preload and the renderer bundles are
 * built together, but a renamed string silently breaks the two ends apart. The
 * snapshot is the alarm.
 */
describe('CH: the channel set is a wire protocol', () => {
  it('matches the snapshot', () => {
    expect(channels).toMatchSnapshot()
  })

  it('names every channel exactly once', () => {
    const names = channels.map(([, channel]) => channel)
    expect(new Set(names).size).toBe(names.length)
  })

  it('names each channel after its own path in the map', () => {
    // `settings.hold` must be `settings:hold`: the namespace is not decoration,
    // it is how the two ends agree on who owns the handler.
    for (const [path, channel] of channels) {
      const [namespace, key] = path.split('.')
      // Both halves are kebab-cased: `voice.downloadProgress` is `voice:download-progress`.
      const kebab = (part: string): string => part.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)
      expect(channel, path).toBe(`${kebab(namespace)}:${kebab(key)}`)
    }
  })

  it('keeps the namespaces the app is built around', () => {
    expect(Object.keys(CH).sort()).toEqual([
      'agent',
      'drawing',
      'onboarding',
      'overlay',
      'permissions',
      'settings',
      'tts',
      'update',
      'voice'
    ])
  })

  it('keeps the size of every namespace', () => {
    const counts: Record<string, number> = {}
    for (const [path] of channels) {
      const namespace = path.split('.')[0]
      counts[namespace] = (counts[namespace] ?? 0) + 1
    }
    expect(counts).toMatchSnapshot()
  })
})
