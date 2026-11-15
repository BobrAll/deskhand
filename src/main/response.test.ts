import { describe, expect, it } from 'vitest'

import type { Annotation } from '@shared/types'
import { ResponseStream, type ParsedChunk } from './response'

interface Result {
  text: string
  annotations: Annotation[]
}

/** What the stream read from `chunks`: the prose, the shapes and the directive. */
interface Parsed extends Result {
  webLookup: boolean
}

/** Feeds `chunks`, then `finish()`, and concatenates everything the stream emitted. */
function read(chunks: string[]): Parsed {
  const stream = new ResponseStream()
  const out: Parsed = { text: '', annotations: [], webLookup: false }
  const absorb = (chunk: ParsedChunk): void => {
    out.text += chunk.text
    out.annotations.push(...chunk.annotations)
  }
  for (const chunk of chunks) absorb(stream.push(chunk))
  absorb(stream.finish())
  out.webLookup = stream.webLookup
  return out
}

function run(chunks: string[]): Result {
  const { text, annotations } = read(chunks)
  return { text, annotations }
}

const whole = (input: string): Result => run([input])

/** Whether the stream read the input as a request for a web lookup. */
const lookup = (chunks: string[]): boolean => read(chunks).webLookup

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
      annotations: [{ kind: 'arrow', from: { x: 0.5, y: 0.8 }, to: { x: 0.82, y: 0.11 }, label: 'Сюда' }]
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

  it('flushes a held tail that turned out to be prose on finish()', () => {
    const stream = new ResponseStream()

    expect(stream.push('@po').text).toBe('')
    // `@po` never became a marker and never got a newline, so it is returned
    // exactly as it arrived — no newline the model did not write.
    expect(stream.finish()).toEqual({ text: '@po', annotations: [] })
  })

  it('finish() is idempotent and empty when nothing was held', () => {
    const stream = new ResponseStream()

    expect(stream.finish()).toEqual({ text: '', annotations: [] })
    stream.push('@po')
    expect(stream.finish().text).toBe('@po')
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
    expect(whole('@')).toEqual({ text: '@', annotations: [] })
  })
})

describe('ResponseStream: the web lookup marker', () => {
  it('drops a bare marker instead of printing it', () => {
    expect(whole('@web\n')).toEqual({ text: '', annotations: [] })
    expect(lookup(['@web\n'])).toBe(true)
  })

  it('reads the marker with the request restated after it', () => {
    const input = '@web Найди игру: симулятор с выполнением заданий посетителей\n'

    expect(whole(input).text).toBe('')
    expect(lookup([input])).toBe(true)
  })

  it('gives the same answer however the marker line is split', () => {
    const input = '@web Найди игру: симулятор с заданиями посетителей\n'

    for (const chunks of [byChar(input), byTwo(input), byLine(input), [input]]) {
      expect(run(chunks).text, JSON.stringify(chunks)).toBe('')
      expect(lookup(chunks), JSON.stringify(chunks)).toBe(true)
    }
  })

  it('treats a marker without a newline as the marker, not as prose', () => {
    expect(run(['@web Найди игру']).text).toBe('')
    expect(lookup(['@web Найди игру'])).toBe(true)
  })

  it('drops only the marker line and keeps the answer after it', () => {
    expect(run(['@web Найди игру\nГотово\n'])).toEqual({ text: 'Готово\n', annotations: [] })
    expect(lookup(['@web Найди игру\nГотово\n'])).toBe(true)
  })

  it('matches the marker regardless of case and line ending', () => {
    expect(whole('@WEB Найди игру\r\n').text).toBe('')
    expect(lookup(['@Web Найди игру\r\n'])).toBe(true)
  })

  it('keeps the marker when it sits inside a sentence', () => {
    expect(whole('напиши @web и всё\n').text).toBe('напиши @web и всё\n')
    expect(lookup(['напиши @web и всё\n'])).toBe(false)
  })

  it('keeps a word that only starts like the marker', () => {
    expect(whole('@website это сайт\n').text).toBe('@website это сайт\n')
    expect(lookup(['@website это сайт\n'])).toBe(false)
  })

  it('does not read a marker glued to a word as a directive', () => {
    expect(whole('@webсайт — это не команда\n').text).toBe('@webсайт — это не команда\n')
    expect(lookup(['@webсайт — это не команда\n'])).toBe(false)
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
    expect(out.annotations).toEqual([{ kind: 'arrow', from: { x: 0.1, y: 0.2 }, to: { x: 0.3, y: 0.4 }, label: 'x' }])
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

describe('ResponseStream: what a chunk carries', () => {
  it('collects shapes in arrival order', () => {
    const out = whole('@point circle 0.2 0.2 0.3 0.3\n@point arrow 0.1 0.1 0.4 0.4\n')

    expect(out.annotations.map((shape) => shape.kind)).toEqual(['circle', 'arrow'])
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
    const pushed = stream.push('@point circle 0.2 0.2 0.3 0.3\n')
    const flushed = stream.finish()

    expect(pushed.annotations).toHaveLength(1)
    expect(flushed.annotations).toEqual([])
  })
})

describe('ResponseStream: any chunking gives an identical result', () => {
  // Markers at column 0 — the shape the protocol asks the model for — and the
  // shapes that only look like markers once a network chunk boundary cuts them.
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
    `${ARROW_LINE}\n${CIRCLE_LINE}\n`,
    // A marker that starts mid-line is prose: it is not at the start of its own
    // line, and the answer must not depend on where the network cut it.
    `x ${CIRCLE_LINE}\n`,
    `Скажу так: ${ARROW_LINE}\nготово\n`,
    // The prompt's own example is indented by two spaces, and a model that
    // copies it writes the same indent.
    `  ${CIRCLE_LINE}\n`,
    '   @point 0.5 0.5\n',
    'tail @cl',
    'Готово\n@po',
    '@usern',
    '  @hover 0.1 0.2\n',
    '@web\nИщу\n',
    '@web Найди игру: симулятор с заданиями посетителей\n',
    '  @web Найди игру\n'
  ]

  it('matches the whole-string result for every fixed chunking', () => {
    for (const input of corpus) {
      const reference = read([input])
      const label = JSON.stringify(input)

      expect(read(byChar(input)), `by char: ${label}`).toEqual(reference)
      expect(read(byTwo(input)), `by two: ${label}`).toEqual(reference)
      expect(read(byLine(input)), `by line: ${label}`).toEqual(reference)
    }
  })

  it('matches the whole-string result for random chunkings', () => {
    for (const input of corpus) {
      const reference = read([input])
      for (let seed = 1; seed <= 20; seed += 1) {
        expect(read(randomChunks(input, seed)), `${JSON.stringify(input)} seed ${seed}`).toEqual(reference)
      }
    }
  })

  it('is not vacuous: the corpus really produces shapes and text', () => {
    expect(whole(corpus[2]).annotations).toHaveLength(1)
    expect(whole(corpus[3]).annotations).toHaveLength(1)
    expect(whole(corpus[0]).text).toBe('Просто ответ')
    expect(whole(corpus[4]).annotations.map((shape) => shape.kind)).toEqual(['box', 'underline'])
    expect(whole(corpus[14]).annotations, 'indented marker').toHaveLength(1)
    expect(lookup([corpus[21]]), 'marker with the request after it').toBe(true)
  })

  it('treats a marker that starts mid-line as prose however it is split', () => {
    const input = `x ${CIRCLE_LINE}\n`
    const wholeLine = whole(input)

    expect(wholeLine.text).toBe(input)
    expect(wholeLine.annotations).toEqual([])
    // Every split of the same output gives the same answer: no drawing, and the
    // marker line printed as the text the model wrote.
    for (const split of [
      ['x ', `${CIRCLE_LINE}\n`],
      ['x @point ci', `rcle 0.42 0.31 0.52 0.41 «Экспорт»\n`]
    ]) {
      expect(run(split), JSON.stringify(split)).toEqual(wholeLine)
    }
  })

  it('flushes a prose tail without the newline of a complete line', () => {
    expect(whole('tail @cl').text).toBe('tail @cl')
    expect(run(['tail ', '@cl']).text).toBe('tail @cl')
    expect(whole('Готово\n@po').text).toBe('Готово\n@po')
    expect(run(byChar('Готово\n@po')).text).toBe('Готово\n@po')
  })

  it('drops the indent in front of a marker instead of printing it', () => {
    expect(whole('   @point 0.5 0.5\n').text).toBe('')
    expect(run(byChar('   @point 0.5 0.5\n')).text).toBe('')
    expect(run(byChar('   @point 0.5 0.5\n')).annotations).toHaveLength(1)
    // Whitespace in front of ordinary text is answer text and stays.
    expect(run(byChar('   привет\n')).text).toBe('   привет\n')
  })
})
