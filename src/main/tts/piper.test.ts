import { beforeEach, describe, expect, it, vi } from 'vitest'
import { piperBinary, piperModel } from './piper'

const files = vi.hoisted(() => new Set<string>())

vi.mock('node:fs', () => ({ existsSync: (path: string) => files.has(path) }))
vi.mock('../paths', () => ({ resourcePath: (name: string) => `/bundle/${name}` }))

beforeEach(() => files.clear())

describe('bundled Piper resources', () => {
  it('resolves the bundled executable', () => {
    expect(piperBinary()).toBeNull()
    files.add('/bundle/piper/engine/piper')
    expect(piperBinary()).toBe('/bundle/piper/engine/piper')
  })

  it('requires both bundled Ruslan files and ignores legacy voices', () => {
    const ruslan = '/bundle/piper/voices/ru_RU-ruslan-medium.onnx'
    const legacyVoice = '/userdata/piper/voices/ru_RU-irina-medium.onnx'
    files.add(legacyVoice)
    files.add(`${legacyVoice}.json`)
    expect(piperModel()).toBeNull()

    files.add(ruslan)
    expect(piperModel()).toBeNull()
    files.add(`${ruslan}.json`)
    expect(piperModel()).toBe(ruslan)
  })
})
