import { describe, expect, it } from 'vitest'

import type { Annotation } from '@shared/types'
import { ResponseStream, type ParsedChunk } from './response'

interface Result {
  text: string
  annotations: Annotation[]
}

/** Feeds `chunks`, then `finish()`, and concatenates everything the stream emitted. */
function run(chunks: string[]): Result {
  const stream = new ResponseStream()
  const out: Result = { text: '', annotations: [] }
  const absorb = (chunk: ParsedChunk): void => {
    out.text += chunk.text
    out.annotations.push(...chunk.annotations)
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

const CIRCLE_LINE = '@point circle 0.42 0.31 0.52 0.41 «Экспорт»'
const ARROW_LINE = '@point arrow 0.5 0.8 0.82 0.11 «Сюда»'

describe('ResponseStream: a marker cut by a chunk boundary', () => {
  it('holds a tail that starts with @ and completes it on the next chunk', () => {
    const stream = new ResponseStream()

    expect(stream.push('Готово\n@po')).toEqual({ text: 'Готово\n', annotations: [] })
    expect(stream.push(`int arrow 0.5 0.8 0.82 0.11 «Сюда»\n`)).toEqual({
      text: '',
      annotations: [
        { kind: 'arrow', from: { x: 0.5, y: 0.8 }, to: { x: 0.82, y: 0.11 }, label: 'Сюда' }
      ]
    })
  })

  it('holds a bare @po and never prints it into the answer', () => {
    const stream = new ResponseStream()

    expect(stream.push('@po')).toEqual({ text: '', annotations: [] })
    expect(stream.push('int circle 0.4 0.3 0.5 0.4\n').annotations).toEqual([
      { kind: 'circle', from: { x: 0.4, y: 0.3 }, to: { x: 0.5, y: 0.4 } }
    ])
  })

  it('holds a tail whose marker is preceded by whitespace', () => {
    const stream = new ResponseStream()

    expect(stream.push('   @po')).toEqual({ text: '', annotations: [] })
    expect(stream.push('int 0.5 0.5\n').annotations).toHaveLength(1)
  })

  it('flushes the held tail on finish(), parsed as a line', () => {
    const stream = new ResponseStream()

    expect(stream.push('@po').text).toBe('')
    // The tail never got its newline; `consume()` appends one.
    expect(stream.finish()).toEqual({ text: '@po\n', annotations: [] })
  })

  it('finish() is idempotent and empty when nothing was held', () => {
    const stream = new ResponseStream()

    expect(stream.finish()).toEqual({ text: '', annotations: [] })
    stream.push('@po')
    expect(stream.finish().text).toBe('@po\n')
    expect(stream.finish()).toEqual({ text: '', annotations: [] })
  })
})

describe('ResponseStream: a line with @ that is not a command', () => {
  it('passes @username through as text', () => {
    expect(whole('@username привет\n')).toEqual({
      text: '@username привет\n',
      annotations: []
    })
  })

  it('passes an @ inside a sentence through as text', () => {
    expect(whole('пиши на a@b.c')).toEqual({ text: 'пиши на a@b.c', annotations: [] })
  })

  it('passes an unknown @command through as text', () => {
    expect(whole('@hover 0.1 0.2\n').text).toBe('@hover 0.1 0.2\n')
  })

  it('passes a lone @ through as text', () => {
    expect(whole('@')).toEqual({ text: '@\n', annotations: [] })
  })
})

describe('ResponseStream: unusable markers are swallowed', () => {
  it('drops a marker with no usable coordinates', () => {
    expect(whole('@point\n')).toEqual({ text: '', annotations: [] })
    expect(whole('@point arrow x y z w\n')).toEqual({ text: '', annotations: [] })
  })

  it('keeps the surrounding text and drops only the bad line', () => {
    expect(whole('до\n@point тут мусор\nпосле\n').text).toBe('до\nпосле\n')
  })

  it('prints a line that only looks like an old action marker', () => {
    // Nothing parses `@click` any more. Dropping it would lose text the user is
    // reading; printing it is the honest outcome of a protocol that no longer
    // has that line.
    expect(whole('@click abc\n').text).toBe('@click abc\n')
    expect(whole('до\n@click тут\nпосле\n').text).toBe('до\n@click тут\nпосле\n')
  })

  it('drops a degenerate box but keeps a single-point circle', () => {
    expect(whole('@point box 0.1 0.2 0.1 0.2\n')).toEqual({
      text: '',
      annotations: []
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
  it('collects shapes in arrival order', () => {
    const stream = new ResponseStream()
    stream.push('@point circle 0.2 0.2 0.3 0.3\n@point arrow 0.1 0.1 0.4 0.4\n')
    stream.finish()

    expect(stream.collected().map((shape) => shape.kind)).toEqual(['circle', 'arrow'])
  })

  it('prints an action-shaped line as text now that acting is not a marker', () => {
    // The old protocol had a second line grammar for clicks. Acting is a
    // separate turn with real tool calling, so a line that looks like one is
    // just prose — and printing it is better than silently swallowing it.
    const out = whole('@click 0.1 0.1\n')

    expect(out.annotations).toEqual([])
    expect(out.text).toBe('@click 0.1 0.1\n')
  })

  it('does not double count when finish() has nothing to flush', () => {
    const stream = new ResponseStream()
    stream.push('@point circle 0.2 0.2 0.3 0.3\n')
    stream.finish()

    expect(stream.collected()).toHaveLength(1)
  })
})

describe('ResponseStream: any chunking gives an identical result', () => {
  // Markers at column 0 — the shape the protocol asks the model for.
  const corpus = [
    'Просто ответ',
    'Строка один\nСтрока два\n',
    `${ARROW_LINE}\nГотово\n`,
    `Текст\n${CIRCLE_LINE}\nТекст после\n`,
    '@point box 0.1 0.1 0.3 0.3\n@point underline 0.5 0.5 0.7 0.7\n',
    'до\n@point тут мусор\nпосле\n',
    'a\r\nb\r\n@point 0.1 0.2 0.3 0.4\r\n',
    '\n\n\n',
    '@po',
    '@point',
    '@',
    `${ARROW_LINE}\n${CIRCLE_LINE}\n`
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

  it('is not vacuous: the corpus really produces shapes and text', () => {
    expect(whole(corpus[2]).annotations).toHaveLength(1)
    expect(whole(corpus[3]).annotations).toHaveLength(1)
    expect(whole(corpus[0]).text).toBe('Просто ответ')
    expect(whole(corpus[4]).annotations.map((shape) => shape.kind)).toEqual(['box', 'underline'])
  })

  // KNOWN BUG: characterization — `push()` decides whether to hold the tail by
  // looking at the whole pending string, so a tail that starts with text is
  // flushed before its `@` ever arrives.
  it('differs on a marker that starts mid-line (known bug)', () => {
    const wholeLine = whole(`x ${CIRCLE_LINE}\n`)
    expect(wholeLine.text).toBe(`x ${CIRCLE_LINE}\n`)
    expect(wholeLine.annotations).toEqual([])

    const split = run(['x ', `${CIRCLE_LINE}\n`])
    expect(split.text).toBe('x ')
    expect(split.annotations).toHaveLength(1)
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
