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

describe('CH (smoke)', () => {
  it('exposes a non-empty map of namespaced channel names', () => {
    const channels = flatten(CH)

    expect(channels.length).toBeGreaterThan(0)
    for (const [path, channel] of channels) {
      expect(channel, path).toMatch(/^[a-z][a-z0-9-]*:[a-z][a-z0-9-]*$/)
    }
  })
})
