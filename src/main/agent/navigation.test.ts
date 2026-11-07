import { describe, expect, it } from 'vitest'
import { DEFAULT_AGENT } from '@shared/defaults'
import { navigationUrl } from './navigation'
import { normalizePlan } from './plan'
import { parseAgentLine } from './protocol'

describe('web navigation', () => {
  const url = 'https://example.org/catalog?q=space'

  it('allows an explicit URL or the homepage of a named domain', () => {
    expect(navigationUrl(url, 'Открой ' + url)).toBe(url)
    expect(navigationUrl('https://example.org/', 'Открой example.org')).toBe('https://example.org/')
    expect(navigationUrl(url, 'Открой example.org')).toBeNull()
    expect(navigationUrl('https://example.org.evil.test/', 'Открой example.org')).toBeNull()
    expect(navigationUrl('https://example.org/', 'Отправь письмо на user@example.org')).toBeNull()
  })

  it('rejects non-web schemes and credentials', () => {
    expect(navigationUrl('file:///tmp/foo', 'Открой file:///tmp/foo')).toBeNull()
    expect(navigationUrl('https://name:secret@example.org', 'Открой https://name:secret@example.org')).toBeNull()
  })

  it('opens the browser instead of following an unverified web address', () => {
    const navigate = parseAgentLine('@navigate ' + url) ?? []
    const options = { settings: DEFAULT_AGENT, area: null, prompt: 'Открой каталог библиотеки' }
    expect(normalizePlan(navigate, options)).toMatchObject({
      wantsLook: true, steps: [{ action: { kind: 'browser' } }]
    })
    expect(normalizePlan(navigate, { ...options, prompt: 'Открой ' + url }).steps).toEqual(navigate)
    const localFile = parseAgentLine('@navigate file:///tmp/test') ?? []
    expect(normalizePlan(localFile, options).steps).toEqual(localFile)
  })

  it('requires a fresh frame before executing any step after navigation', () => {
    const navigate = parseAgentLine('@navigate ' + url) ?? []
    const input = parseAgentLine('@type текст из старого плана') ?? []
    expect(normalizePlan([...navigate, ...input], { settings: DEFAULT_AGENT, area: null }))
      .toMatchObject({ wantsLook: true, steps: [{ action: { kind: 'navigate', url } }], rejected: [] })
    expect(normalizePlan([...input, ...navigate], { settings: DEFAULT_AGENT, area: null }).rejected).toHaveLength(1)
    const browser = parseAgentLine('@browser') ?? []
    expect(normalizePlan([...browser, ...input], { settings: DEFAULT_AGENT, area: null }))
      .toMatchObject({ wantsLook: true, steps: [{ action: { kind: 'browser' } }], rejected: [] })
  })
})
