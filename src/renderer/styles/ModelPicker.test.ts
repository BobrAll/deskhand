import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ModelPicker, resolveModelInput } from './ModelPicker'

const noop = () => {}

function render(models: string[], selected: string, query = ''): string {
  return renderToStaticMarkup(
    createElement(ModelPicker, {
      models,
      selected,
      query,
      searchLabel: 'Поиск или ID модели',
      searchPlaceholder: 'Найти или вписать ID модели',
      listLabel: 'Модели сервиса',
      onQuery: noop,
      onSelect: noop
    })
  )
}

describe('ModelPicker', () => {
  it('closes into the chosen model instead of leaving the list open', () => {
    const html = render(['gpt-4.1-mini', 'claude-sonnet-4'], 'claude-sonnet-4')
    expect(html).not.toContain('<input')
    expect(html).not.toContain('role="listbox"')
    expect(html).toContain('aria-label="Модель claude-sonnet-4 выбрана. Сменить"')
    expect(html).toContain('class="model-picker-selected-id">claude-sonnet-4')
    expect(html).toContain('Сменить')
  })

  it('uses one field for the search and a manual ID when there is no choice', () => {
    const html = render(['gpt-4.1-mini', 'claude-sonnet-4'], '')
    expect(html.match(/<input/g)).toHaveLength(1)
    expect(html).toContain('class="model-picker"')
    expect(html).toContain('aria-label="Поиск или ID модели"')
    expect(html).toContain('placeholder="Найти или вписать ID модели"')
    expect(html).toContain('role="listbox" aria-label="Модели сервиса"')
    expect(html).toContain('2 из 2')
    expect(html).not.toContain('Сменить')
  })

  it('filters the list and offers the typed ID when there is no exact match', () => {
    const filtered = render(['gpt-4.1-mini', 'claude-sonnet-4'], '', 'gpt')
    expect(filtered).toContain('1 из 2')
    expect(filtered).not.toContain('claude-sonnet-4')

    expect(render(['gpt-4.1-mini'], '', 'my-own-model')).toContain('Использовать «my-own-model» как ID модели')
    expect(render(['gpt-4.1-mini'], '', 'gpt-4.1-mini')).not.toContain('как ID модели')
  })

  it('flags a chosen ID the catalogue does not contain', () => {
    const html = render(['gpt-4.1-mini'], 'my-own-model')
    expect(html).toContain('В загруженном списке её нет — проверь ID.')
  })

  it('says when the query matches nothing instead of showing an empty frame', () => {
    const html = render(['gpt-4.1-mini'], '', 'gemini')
    expect(html).not.toContain('role="listbox"')
    expect(html).toContain('Совпадений в списке нет.')
  })
})

describe('resolveModelInput', () => {
  const models = ['gpt-4.1-mini', 'claude-sonnet-4']

  it('is empty for an empty field', () => {
    expect(resolveModelInput('   ', models)).toBeNull()
  })

  it('takes the catalogue spelling of an exact match', () => {
    expect(resolveModelInput('GPT-4.1-MINI', models)).toBe('gpt-4.1-mini')
  })

  it('keeps an ID the catalogue does not contain', () => {
    expect(resolveModelInput('  my-own-model  ', models)).toBe('my-own-model')
  })
})
