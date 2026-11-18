/**
 * What the answer reader does with a reply.
 *
 * The cases that matter are the ones a real answer produces: a list without a
 * blank line before it, an arithmetic `*` that is not italics, `snake_case` that
 * is not emphasis, and a half-arrived `**` while the answer streams. The last
 * one is why `streaming` exists at all — a finished answer keeps the marker
 * literal, a streaming one draws it as bold to the end of the line.
 */

import { describe, expect, it } from 'vitest'
import { parseInline, parseMarkdown } from './markdown'

describe('inline markers', () => {
  it('reads bold, italics and inline code', () => {
    expect(parseInline('**жирный**')).toEqual([{ kind: 'strong', children: [{ kind: 'text', text: 'жирный' }] }])
    expect(parseInline('a *b* c')).toEqual([
      { kind: 'text', text: 'a ' },
      { kind: 'em', children: [{ kind: 'text', text: 'b' }] },
      { kind: 'text', text: ' c' }
    ])
    expect(parseInline('`код`')).toEqual([{ kind: 'code', text: 'код' }])
  })

  it('keeps markers inside code literal', () => {
    expect(parseInline('`**x**`')).toEqual([{ kind: 'code', text: '**x**' }])
  })

  it('reads a link and a bare URL', () => {
    expect(parseInline('[док](https://x.dev/a)')).toEqual([{ kind: 'link', text: 'док', href: 'https://x.dev/a' }])
    expect(parseInline('см. https://x.dev/a.')).toEqual([
      { kind: 'text', text: 'см. ' },
      { kind: 'link', text: 'https://x.dev/a', href: 'https://x.dev/a' },
      { kind: 'text', text: '.' }
    ])
  })

  it('does not mistake arithmetic or identifiers for emphasis', () => {
    expect(parseInline('2 * 3 = 6')).toEqual([{ kind: 'text', text: '2 * 3 = 6' }])
    expect(parseInline('snake_case_name')).toEqual([{ kind: 'text', text: 'snake_case_name' }])
  })

  it('leaves an unmatched marker literal in a finished answer', () => {
    expect(parseInline('**незакрытый')).toEqual([{ kind: 'text', text: '**незакрытый' }])
  })

  it('draws an unclosed marker while the answer streams', () => {
    expect(parseInline('**незакрытый', true)).toEqual([
      { kind: 'strong', children: [{ kind: 'text', text: 'незакрытый' }] }
    ])
  })

  it('never treats HTML as markup', () => {
    expect(parseInline('<b>x</b>')).toEqual([{ kind: 'text', text: '<b>x</b>' }])
  })
})

describe('blocks', () => {
  it('keeps a paragraph line by line', () => {
    expect(parseMarkdown('первая\nвторая')).toEqual([
      {
        kind: 'paragraph',
        lines: [[{ kind: 'text', text: 'первая' }], [{ kind: 'text', text: 'вторая' }]]
      }
    ])
  })

  it('separates paragraphs on a blank line', () => {
    expect(parseMarkdown('один\n\nдва')).toHaveLength(2)
  })

  it('reads headings at their level', () => {
    expect(parseMarkdown('## Итог')).toEqual([{ kind: 'heading', level: 2, inlines: [{ kind: 'text', text: 'Итог' }] }])
  })

  it('reads bullet and ordered lists, including the starting number', () => {
    expect(parseMarkdown('- один\n- два')).toEqual([
      {
        kind: 'list',
        ordered: false,
        start: 1,
        items: [[{ kind: 'text', text: 'один' }], [{ kind: 'text', text: 'два' }]]
      }
    ])
    expect(parseMarkdown('3. три\n4. четыре')).toEqual([
      {
        kind: 'list',
        ordered: true,
        start: 3,
        items: [[{ kind: 'text', text: 'три' }], [{ kind: 'text', text: 'четыре' }]]
      }
    ])
  })

  it('ends a paragraph where a list begins, even without a blank line', () => {
    expect(parseMarkdown('вот варианты:\n- один').map((block) => block.kind)).toEqual(['paragraph', 'list'])
  })

  it('reads a rule, not a bullet', () => {
    expect(parseMarkdown('---')).toEqual([{ kind: 'rule' }])
  })

  it('keeps fenced code verbatim', () => {
    expect(parseMarkdown('```ts\nconst a = 1\n```')).toEqual([{ kind: 'code', lang: 'ts', text: 'const a = 1' }])
  })

  it('treats an unterminated fence as code to the end', () => {
    expect(parseMarkdown('```\nconst a = 1')).toEqual([{ kind: 'code', lang: '', text: 'const a = 1' }])
  })

  it('renders nothing for an empty answer', () => {
    expect(parseMarkdown('')).toEqual([])
  })
})

describe('tables', () => {
  it('reads a header, a delimiter row and the body', () => {
    expect(parseMarkdown('| a | b |\n|---|---|\n| 1 | 2 |')).toEqual([
      {
        kind: 'table',
        align: [null, null],
        header: [[{ kind: 'text', text: 'a' }], [{ kind: 'text', text: 'b' }]],
        rows: [[[{ kind: 'text', text: '1' }], [{ kind: 'text', text: '2' }]]]
      }
    ])
  })

  it('accepts a table without the outer pipes', () => {
    const blocks = parseMarkdown('a | b\n--- | ---\n1 | 2')
    expect(blocks[0].kind).toBe('table')
  })

  it('reads column alignment from the colons', () => {
    const [table] = parseMarkdown('| l | c | r |\n|:--|:-:|--:|\n| 1 | 2 | 3 |')
    expect(table.kind === 'table' && table.align).toEqual(['left', 'center', 'right'])
  })

  it('reads a header-only table while it streams', () => {
    expect(parseMarkdown('| a | b |\n|---|---|')).toEqual([
      {
        kind: 'table',
        align: [null, null],
        header: [[{ kind: 'text', text: 'a' }], [{ kind: 'text', text: 'b' }]],
        rows: []
      }
    ])
  })

  it('pads a short row and cuts a long one', () => {
    const [table] = parseMarkdown('| a | b |\n|---|---|\n| 1 |\n| 1 | 2 | 3 |')
    expect(table.kind === 'table' && table.rows).toEqual([
      [[{ kind: 'text', text: '1' }], []],
      [[{ kind: 'text', text: '1' }], [{ kind: 'text', text: '2' }]]
    ])
  })

  it('parses inline markers inside cells', () => {
    const [table] = parseMarkdown('| a |\n|---|\n| **b** |')
    expect(table.kind === 'table' && table.rows[0][0]).toEqual([
      { kind: 'strong', children: [{ kind: 'text', text: 'b' }] }
    ])
  })

  it('keeps an escaped pipe inside a cell', () => {
    const [table] = parseMarkdown('| a | b |\n|---|---|\n| x \\| y | 2 |')
    expect(table.kind === 'table' && table.rows[0][0]).toEqual([{ kind: 'text', text: 'x | y' }])
  })

  it('does not mistake prose with a pipe followed by a rule for a table', () => {
    expect(parseMarkdown('a | b\n---').map((block) => block.kind)).toEqual(['paragraph', 'rule'])
  })

  it('ends a paragraph where a table begins', () => {
    expect(parseMarkdown('вот:\n| a | b |\n|---|---|\n| 1 | 2 |').map((block) => block.kind)).toEqual([
      'paragraph',
      'table'
    ])
  })
})

describe('tables without a delimiter row', () => {
  it('reads the shape a model actually writes', () => {
    const text = [
      'Шаг | Команда | Результат | Детали',
      '1 | swift test | провал | 82 теста',
      '2 | npm test | провал | 16 упавших',
      '3 | npm run lint | успех | ошибок нет'
    ].join('\n')

    expect(parseMarkdown(text)).toEqual([
      {
        kind: 'table',
        align: [null, null, null, null],
        header: [
          { kind: 'text', text: 'Шаг' },
          { kind: 'text', text: 'Команда' },
          { kind: 'text', text: 'Результат' },
          { kind: 'text', text: 'Детали' }
        ].map((cell) => [cell]),
        rows: [
          [
            [{ kind: 'text', text: '1' }],
            [{ kind: 'text', text: 'swift test' }],
            [{ kind: 'text', text: 'провал' }],
            [{ kind: 'text', text: '82 теста' }]
          ],
          [
            [{ kind: 'text', text: '2' }],
            [{ kind: 'text', text: 'npm test' }],
            [{ kind: 'text', text: 'провал' }],
            [{ kind: 'text', text: '16 упавших' }]
          ],
          [
            [{ kind: 'text', text: '3' }],
            [{ kind: 'text', text: 'npm run lint' }],
            [{ kind: 'text', text: 'успех' }],
            [{ kind: 'text', text: 'ошибок нет' }]
          ]
        ]
      }
    ])
  })

  it('stops at the first line that is not a row', () => {
    const blocks = parseMarkdown('a | b\n1 | 2\n\nИтого: всё хорошо')
    expect(blocks.map((block) => block.kind)).toEqual(['table', 'paragraph'])
    expect(blocks[0].kind === 'table' && blocks[0].rows).toHaveLength(1)
  })

  it('leaves one line with a pipe alone', () => {
    expect(parseMarkdown('выбери a | b').map((block) => block.kind)).toEqual(['paragraph'])
  })

  it('leaves prose whose lines do not agree on a count alone', () => {
    expect(parseMarkdown('первая | строка\nвторая').map((block) => block.kind)).toEqual(['paragraph'])
  })

  it('still reads the strict shape when the delimiter row is there', () => {
    const [table] = parseMarkdown('| a | b |\n|--:|:-:|\n| 1 | 2 |')
    expect(table.kind === 'table' && table.align).toEqual(['right', 'center'])
  })
})
