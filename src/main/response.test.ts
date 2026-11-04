import { describe, expect, it } from 'vitest'

import type { AgentPlanStep, Annotation } from '@shared/types'
import { ResponseStream, type ParsedChunk } from './response'

interface Result {
  text: string
  annotations: Annotation[]
  steps: AgentPlanStep[]
}

/** Feeds `chunks`, then `finish()`, and concatenates everything the stream emitted. */
function run(chunks: string[]): Result {
  const stream = new ResponseStream()
  const out: Result = { text: '', annotations: [], steps: [] }
  const absorb = (chunk: ParsedChunk): void => {
    out.text += chunk.text
    out.annotations.push(...chunk.annotations)
    out.steps.push(...chunk.steps)
  }
  for (const chunk of chunks) absorb(stream.push(chunk))
  absorb(stream.finish())
  return out
}

const whole = (input: string): Result => run([input])

const byChar = (input: string): string[] => [...input]
const byTwo = (input: string): string[] => input.match(/[\s\S]{1,2}/g) ?? []
const byLine = (input: string): string[] => input.match(/[^\n]*\n|[^\n]+$/g) ?? []

/** Deterministic pseudo-random chunk sizes, so a failure is reproducible. */
function randomChunks(input: string, seed: number): string[] {
  let state = seed
  const next = (): number => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648
    return state / 2_147_483_648
  }
  const chunks: string[] = []
  let index = 0
  while (index < input.length) {
    const size = 1 + Math.floor(next() * 6)
    chunks.push(input.slice(index, index + size))
    index += size
  }
  return chunks
}

const CLICK_LINE = '@click 0.42 0.31 left «Экспорт»'
const ARROW_LINE = '@point arrow 0.5 0.8 0.82 0.11 «Сюда»'

describe('ResponseStream: a marker cut by a chunk boundary', () => {
  it('holds a tail that starts with @ and completes it on the next chunk', () => {
    const stream = new ResponseStream()

    expect(stream.push('Готово\n@po')).toEqual({ text: 'Готово\n', annotations: [], steps: [] })
    expect(stream.push(`int arrow 0.5 0.8 0.82 0.11 «Сюда»\n`)).toEqual({
      text: '',
      annotations: [
        { kind: 'arrow', from: { x: 0.5, y: 0.8 }, to: { x: 0.82, y: 0.11 }, label: 'Сюда' }
      ],
      steps: []
    })
  })

  it('holds a bare @cl and never prints it into the answer', () => {
    const stream = new ResponseStream()

    expect(stream.push('@cl')).toEqual({ text: '', annotations: [], steps: [] })
    expect(stream.push('ick 0.42 0.31 left «Экспорт»\n').steps).toEqual([
      {
        action: { kind: 'click', at: { x: 0.42, y: 0.31 }, button: 'left', label: 'Экспорт' },
        label: 'Клик: «Экспорт»'
      }
    ])
  })

  it('holds a tail whose marker is preceded by whitespace', () => {
    const stream = new ResponseStream()

    expect(stream.push('   @po')).toEqual({ text: '', annotations: [], steps: [] })
    expect(stream.push('int 0.5 0.5\n').annotations).toHaveLength(1)
  })

  it('flushes the held tail on finish(), parsed as a line', () => {
    const stream = new ResponseStream()

    expect(stream.push('@po').text).toBe('')
    // The tail never got its newline; `consume()` appends one.
    expect(stream.finish()).toEqual({ text: '@po\n', annotations: [], steps: [] })
  })

  it('finish() is idempotent and empty when nothing was held', () => {
    const stream = new ResponseStream()

    expect(stream.finish()).toEqual({ text: '', annotations: [], steps: [] })
    stream.push('@po')
    expect(stream.finish().text).toBe('@po\n')
    expect(stream.finish()).toEqual({ text: '', annotations: [], steps: [] })
  })
})

describe('ResponseStream: a line with @ that is not a command', () => {
  it('passes @username through as text', () => {
    expect(whole('@username привет\n')).toEqual({
      text: '@username привет\n',
      annotations: [],
      steps: []
    })
  })

  it('passes an @ inside a sentence through as text', () => {
    expect(whole('пиши на a@b.c')).toEqual({ text: 'пиши на a@b.c', annotations: [], steps: [] })
  })

  it('passes an unknown @command through as text', () => {
    expect(whole('@hover 0.1 0.2\n').text).toBe('@hover 0.1 0.2\n')
  })

  it('passes a lone @ through as text', () => {
    expect(whole('@')).toEqual({ text: '@\n', annotations: [], steps: [] })
  })
})

describe('ResponseStream: unusable markers are swallowed', () => {
  it('drops a marker with no usable coordinates', () => {
    expect(whole('@point\n')).toEqual({ text: '', annotations: [], steps: [] })
    expect(whole('@point arrow x y z w\n')).toEqual({ text: '', annotations: [], steps: [] })
    expect(whole('@click abc\n')).toEqual({ text: '', annotations: [], steps: [] })
  })

  it('keeps the surrounding text and drops only the bad line', () => {
    expect(whole('до\n@click тут\nпосле\n').text).toBe('до\nпосле\n')
    expect(whole('до\n@point тут мусор\nпосле\n').text).toBe('до\nпосле\n')
  })

  it('drops a degenerate box but keeps a single-point circle', () => {
    expect(whole('@point box 0.1 0.2 0.1 0.2\n')).toEqual({
      text: '',
      annotations: [],
      steps: []
    })
    expect(whole('@point circle 0.5 0.5\n').annotations).toEqual([
      { kind: 'circle', from: { x: 0.5, y: 0.5 }, to: { x: 0.53, y: 0.53 } }
    ])
  })
})

describe('ResponseStream: CRLF and empty lines', () => {
  it('keeps CRLF text verbatim', () => {
    expect(whole('a\r\nb\r\n').text).toBe('a\r\nb\r\n')
  })

  it('parses a marker written with CRLF', () => {
    const out = whole('a\r\n@point arrow 0.1 0.2 0.3 0.4 «x»\r\n')

    expect(out.text).toBe('a\r\n')
    expect(out.annotations).toEqual([
      { kind: 'arrow', from: { x: 0.1, y: 0.2 }, to: { x: 0.3, y: 0.4 }, label: 'x' }
    ])
  })

  it('keeps empty lines', () => {
    expect(whole('a\n\nb\n').text).toBe('a\n\nb\n')
    expect(whole('\n\n\n').text).toBe('\n\n\n')
  })

  it('does not add a newline to a text tail that never had one', () => {
    expect(whole('хвост').text).toBe('хвост')
  })
})

describe('ResponseStream: «» labels', () => {
  it('strips one layer of quotes from the caption', () => {
    for (const wrapped of ['«Сюда»', '"Сюда"', "'Сюда'", '(Сюда)', '[Сюда]']) {
      expect(whole(`@point arrow 0.1 0.2 0.3 0.4 ${wrapped}\n`).annotations[0].label).toBe('Сюда')
    }
  })

  it('has no label when the caption is only quotes', () => {
    expect(whole('@point arrow 0.1 0.2 0.3 0.4 «»\n').annotations[0].label).toBeUndefined()
  })

  it('keeps the caption out of the answer text', () => {
    expect(whole(`${ARROW_LINE}\n`).text).toBe('')
  })
})

describe('ResponseStream: accumulated results', () => {
  it('collects shapes and steps in arrival order', () => {
    const stream = new ResponseStream()
    stream.push('@click 0.1 0.1\n@point circle 0.2 0.2\n@wait 100\n@click 0.3 0.3\n')
    stream.finish()

    expect(stream.plan().map((step) => step.action.kind)).toEqual(['click', 'wait', 'click'])
    expect(stream.collected()).toHaveLength(1)
  })

  it('tries an action line before an annotation line', () => {
    const out = whole('@click 0.1 0.1\n')

    expect(out.text).toBe('')
    expect(out.annotations).toEqual([])
    expect(out.steps).toHaveLength(1)
  })

  it('does not double count when finish() has nothing to flush', () => {
    const stream = new ResponseStream()
    stream.push('@click 0.1 0.1\n')
    stream.finish()

    expect(stream.plan()).toHaveLength(1)
    expect(stream.collected()).toEqual([])
  })
})

describe('ResponseStream: any chunking gives an identical result', () => {
  // Markers at column 0 — the shape the protocol asks the model for.
  const corpus = [
    'Просто ответ',
    'Строка один\nСтрока два\n',
    `${ARROW_LINE}\nГотово\n`,
    `Текст\n${CLICK_LINE}\nТекст после\n`,
    '@click 0.1 0.1\n@move 0.5 0.5\n@type Привет, мир\n@done «Всё»\n',
    'до\n@point тут мусор\nпосле\n',
    'a\r\nb\r\n@point 0.1 0.2 0.3 0.4\r\n',
    '\n\n\n',
    '@po',
    '@point',
    '@',
    `${ARROW_LINE}\n${CLICK_LINE}\n@wait 300\n`
  ]

  it('matches the whole-string result for every fixed chunking', () => {
    for (const input of corpus) {
      const reference = whole(input)
      const label = JSON.stringify(input)

      expect(run(byChar(input)), `by char: ${label}`).toEqual(reference)
      expect(run(byTwo(input)), `by two: ${label}`).toEqual(reference)
      expect(run(byLine(input)), `by line: ${label}`).toEqual(reference)
    }
  })

  it('matches the whole-string result for random chunkings', () => {
    for (const input of corpus) {
      const reference = whole(input)
      for (let seed = 1; seed <= 20; seed += 1) {
        expect(run(randomChunks(input, seed)), `${JSON.stringify(input)} seed ${seed}`).toEqual(
          reference
        )
      }
    }
  })

  it('is not vacuous: the corpus really produces shapes, steps and text', () => {
    expect(whole(corpus[2]).annotations).toHaveLength(1)
    expect(whole(corpus[3]).steps).toHaveLength(1)
    expect(whole(corpus[0]).text).toBe('Просто ответ')
    expect(whole(corpus[4]).steps.map((step) => step.action.kind)).toEqual([
      'click',
      'move',
      'type',
      'done'
    ])
  })

  // KNOWN BUG: characterization — `push()` decides whether to hold the tail by
  // looking at the whole pending string, so a tail that starts with text is
  // flushed before its `@` ever arrives.
  it('differs on a marker that starts mid-line (known bug)', () => {
    const wholeLine = whole(`x ${CLICK_LINE}\n`)
    expect(wholeLine.text).toBe(`x ${CLICK_LINE}\n`)
    expect(wholeLine.steps).toEqual([])

    const split = run(['x ', `${CLICK_LINE}\n`])
    expect(split.text).toBe('x ')
    expect(split.steps).toHaveLength(1)
  })

  // KNOWN BUG: characterization — same root cause: the trailing text tail is
  // flushed without the newline that a per-line split would add.
  it('differs on a text tail that ends with @ (known bug)', () => {
    expect(whole('tail @cl').text).toBe('tail @cl')
    expect(run(['tail ', '@cl']).text).toBe('tail @cl\n')
  })

  // KNOWN BUG: characterization — leading whitespace before a marker is flushed
  // as answer text, so the answer gains spaces that the whole-string feed keeps.
  it('differs on whitespace in front of a marker (known bug)', () => {
    expect(whole('   @point 0.5 0.5\n').text).toBe('')
    expect(run(byChar('   @point 0.5 0.5\n')).text).toBe('   ')
  })
})
