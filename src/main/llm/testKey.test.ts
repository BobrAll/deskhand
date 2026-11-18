import { afterEach, describe, expect, it, vi } from 'vitest'
import { listProviderModels, testApiKey } from './testKey'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('listProviderModels', () => {
  it('uses the provider default with an empty Base URL and deduplicates model IDs', async () => {
    const fetch = vi.fn(async () => Response.json({ data: [{ id: 'z' }, { id: 'a' }, { id: 'z' }, null] }))
    vi.stubGlobal('fetch', fetch)

    await expect(listProviderModels('openai', 'example', '')).resolves.toEqual({ ok: true, models: ['a', 'z'] })
    expect(fetch).toHaveBeenCalledWith(
      new URL('https://api.openai.com/v1/models'),
      expect.objectContaining({
        headers: { Authorization: 'Bearer example' },
        redirect: 'error'
      })
    )
  })

  it('uses the override and reads further pages from Anthropic-compatible APIs', async () => {
    const requests: string[] = []
    const fetch = vi.fn(async (url: URL) => {
      requests.push(url.href)
      return url.searchParams.has('after_id')
        ? Response.json({ data: [{ id: 'second' }], has_more: false })
        : Response.json({ data: [{ id: 'first' }], has_more: true, last_id: 'first' })
    })
    vi.stubGlobal('fetch', fetch)

    await expect(listProviderModels('anthropic', 'example', 'https://gateway.example/v1/')).resolves.toEqual({
      ok: true,
      models: ['first', 'second']
    })
    expect(requests).toEqual(['https://gateway.example/v1/models', 'https://gateway.example/v1/models?after_id=first'])
    expect(fetch.mock.calls).toHaveLength(2)
  })

  it('fails cleanly when a custom service has no catalog and never falls back on an invalid override', async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 404 }))
    vi.stubGlobal('fetch', fetch)

    await expect(listProviderModels('openrouter', 'example', 'invalid')).resolves.toMatchObject({ ok: false })
    expect(fetch).not.toHaveBeenCalled()
    await expect(listProviderModels('openrouter', 'example', 'https://gateway.example/v1')).resolves.toMatchObject({
      ok: false
    })
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})

describe('testApiKey', () => {
  it('refuses an empty key without a request', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)

    await expect(testApiKey('openai', '   ')).resolves.toEqual({ ok: false, message: 'Введи ключ.' })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('reports a working key', async () => {
    const fetch = vi.fn(async () => Response.json({ data: [] }))
    vi.stubGlobal('fetch', fetch)

    await expect(testApiKey('openai', 'sk-test', '')).resolves.toEqual({
      ok: true,
      message: 'Ключ OpenAI работает.'
    })
  })

  it('gives the error body the same deadline as the headers', async () => {
    const controller = new AbortController()
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal)
    let startedReading!: () => void
    const reading = new Promise<void>((resolve) => {
      startedReading = resolve
    })
    let requestSignal: AbortSignal | undefined
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      requestSignal = init.signal ?? undefined
      return {
        ok: false,
        status: 500,
        text: () =>
          new Promise<string>((_resolve, reject) => {
            startedReading()
            requestSignal?.addEventListener('abort', () =>
              reject(new DOMException('The operation was aborted due to timeout', 'TimeoutError'))
            )
          })
      } as unknown as Response
    })
    vi.stubGlobal('fetch', fetch)

    const result = testApiKey('openai', 'sk-test', '')
    await reading
    expect(timeout).toHaveBeenCalledWith(12_000)
    expect(requestSignal).toBe(controller.signal)

    controller.abort()
    await expect(result).resolves.toEqual({
      ok: false,
      message: 'Превышено время ожидания ответа.'
    })
  })
})
