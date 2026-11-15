import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '@shared/defaults'
import { searchWeb } from './webSearch'

afterEach(() => vi.unstubAllGlobals())

describe('searchWeb', () => {
  it.each([
    [
      'openrouter',
      'custom/router-model',
      '/chat/completions',
      {
        model: 'custom/router-model',
        tools: [{ type: 'openrouter:web_search', parameters: { max_results: 5, max_total_results: 10 } }]
      },
      {
        choices: [{ message: { content: 'Курс на 5 ноября. https://example.com/rate' } }],
        usage: { server_tool_use: { web_search_requests: 1 } }
      }
    ],
    [
      'openai',
      'gpt-6-astra',
      '/responses',
      {
        model: 'gpt-6-astra',
        store: false,
        tools: [{ type: 'web_search', search_context_size: 'low' }],
        tool_choice: 'required'
      },
      {
        output: [
          { type: 'web_search_call' },
          {
            type: 'message',
            content: [
              {
                type: 'output_text',
                text: 'Курс на 5 ноября.',
                annotations: [{ type: 'url_citation', url: 'https://example.com/rate' }]
              }
            ]
          }
        ]
      }
    ],
    [
      'anthropic',
      'claude-search-model',
      '/messages',
      {
        model: 'claude-search-model',
        tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }]
      },
      {
        content: [
          {
            type: 'text',
            text: 'Курс на 5 ноября.',
            citations: [{ url: 'https://example.com/rate' }]
          }
        ]
      }
    ]
  ] as const)('uses the %s search API with model override %j', async (provider, model, path, params, result) => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json(result))
    vi.stubGlobal('fetch', fetch)
    const settings = {
      ...DEFAULT_SETTINGS,
      provider,
      searchModels: { ...DEFAULT_SETTINGS.searchModels, [provider]: model },
      baseUrls: { ...DEFAULT_SETTINGS.baseUrls, [provider]: 'https://api.example/v1' }
    }
    const answer = await searchWeb('Курс доллара', settings, 'key', new AbortController().signal)

    const [url, request] = fetch.mock.calls[0]
    expect(url).toBe(`https://api.example/v1${path}`)
    const body = JSON.parse(String(request?.body))
    expect(body).toMatchObject(params)
    if (path === '/responses') {
      expect(body.input).toBe('Курс доллара')
    } else {
      expect(body.messages.filter((message: { role: string }) => message.role !== 'system')).toEqual([
        { role: 'user', content: 'Курс доллара' }
      ])
    }
    expect(answer).toContain('Курс на 5 ноября.')
    expect(answer).toContain('https://example.com/rate')
  })

  it.each([
    ['https://plusvibeapi.ru/v1', 'deepseek-v4.1-flash-1017:network', 'deepseek-v4.1-flash-1017:network'],
    ['https://gw.plusvibeapi.ru/v1', '', 'deepseek-v4.1-flash-1017']
  ])('uses the PlusVibe search format at %s with override %j', async (baseUrl, override, model) => {
    const content = 'Курс на 5 ноября. [Банк России](https://example.com/rate)'
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      Response.json({
        choices: [{ message: { content } }]
      })
    )
    vi.stubGlobal('fetch', fetch)
    const settings = {
      ...DEFAULT_SETTINGS,
      provider: 'openai' as const,
      models: { ...DEFAULT_SETTINGS.models, openai: 'deepseek-v4.1-flash-1017' },
      searchModels: { ...DEFAULT_SETTINGS.searchModels, openai: override },
      baseUrls: { ...DEFAULT_SETTINGS.baseUrls, openai: baseUrl }
    }

    await expect(searchWeb('Курс доллара', settings, 'key', new AbortController().signal)).resolves.toBe(content)
    const [url, request] = fetch.mock.calls[0]
    expect(url).toBe(`${baseUrl}/chat/completions`)
    expect(JSON.parse(String(request?.body))).toMatchObject({
      model,
      web_search_options: { search_context_size: 'low' }
    })
  })

  it('still requires a source when PlusVibe returns plain text', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        Response.json({
          choices: [{ message: { content: 'Выдуманный курс' } }]
        })
      )
    )
    const settings = {
      ...DEFAULT_SETTINGS,
      provider: 'openai' as const,
      baseUrls: { ...DEFAULT_SETTINGS.baseUrls, openai: 'https://plusvibeapi.ru/v1' }
    }
    await expect(searchWeb('Курс доллара', settings, 'key', new AbortController().signal)).resolves.toBe(
      'Не удалось подтвердить ответ по результатам веб-поиска.'
    )
  })

  it('does not show an ungrounded model answer when the tool was skipped', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        Response.json({
          choices: [{ message: { content: 'Выдуманный курс' } }]
        })
      )
    )
    await expect(searchWeb('Курс доллара', DEFAULT_SETTINGS, 'key', new AbortController().signal)).resolves.toBe(
      'Не удалось подтвердить ответ по результатам веб-поиска.'
    )
  })
})
