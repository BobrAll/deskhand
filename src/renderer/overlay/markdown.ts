/**
 * A small Markdown reader for the answer.
 *
 * This is deliberately not a Markdown library. The answer is printed in a card
 * at most 360 points wide (`CARD_WIDTH` in `@shared/metrics.ts`), and what models actually
 * write there is headings, short lists, fenced code, tables and the four inline
 * markers — bold, italics, code and links. Everything else (HTML, reference links,
 * nested lists) would be code nobody reads and screen space nobody has.
 *
 * Tables come in the two shapes replies use: with a delimiter row, which is the
 * only one that can carry column alignment, and without it, which is what models
 * write most of the time. `tableAt` recognises both.
 *
 * HTML is never interpreted: the renderer turns tokens into React elements, so
 * `<script>` in a reply is text, not markup. That is also why there is no
 * `dangerouslySetInnerHTML` anywhere near this file.
 *
 * `streaming` is the one concession to text that arrives in pieces. An unclosed
 * `**` at the end of the answer is drawn as bold to the end of the line instead
 * of showing two asterisks that turn into formatting a token later; the same
 * goes for an unterminated fence, whose remaining lines are still code. A
 * finished answer is parsed strictly, and an unmatched marker stays literal.
 */

/** A run of text inside a block. */
export type Inline =
  | { kind: 'text'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'strong'; children: Inline[] }
  | { kind: 'em'; children: Inline[] }
  | { kind: 'link'; text: string; href: string }

/** One line of an answer's structure. */
export type Block =
  /** Consecutive lines of prose; each line is kept, because a newline in an answer is deliberate. */
  | { kind: 'paragraph'; lines: Inline[][] }
  | { kind: 'heading'; level: number; inlines: Inline[] }
  | { kind: 'list'; ordered: boolean; start: number; items: Inline[][] }
  | { kind: 'code'; lang: string; text: string }
  | { kind: 'rule' }
  | { kind: 'table'; align: CellAlign[]; header: Inline[][]; rows: Inline[][][] }

/** How a column's cells line up, from the `:`s in the delimiter row. */
export type CellAlign = 'left' | 'center' | 'right' | null

const FENCE = /^\s*```([\w+#.-]*)\s*$/
const CLOSING_FENCE = /^\s*```\s*$/
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*$/
const BULLET = /^\s{0,3}[-*+]\s+(.*)$/
const ORDERED = /^\s{0,3}(\d{1,9})[.)]\s+(.*)$/
const RULE = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/
const LINK = /^\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/
const URL = /^https?:\/\/[^\s<>()\]]+/
const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u
/** One cell of a delimiter row: dashes, optionally anchored by a colon. */
const DELIM_CELL = /^:?-+:?$/

/**
 * Splits a table row into cells.
 *
 * A leading or trailing pipe is decoration, not an empty cell — that is the
 * whole difference between `| a | b |` and `a | b`. `\|` is an escaped pipe
 * inside a cell, which is how a cell shows one.
 */
function splitRow(line: string): string[] {
  let row = line.trim()
  if (row.startsWith('|')) row = row.slice(1)
  if (row.endsWith('|') && !row.endsWith('\\|')) row = row.slice(0, -1)

  const cells: string[] = []
  let buffer = ''
  for (let i = 0; i < row.length; i += 1) {
    if (row[i] === '\\' && row[i + 1] === '|') {
      buffer += '|'
      i += 1
      continue
    }
    if (row[i] === '|') {
      cells.push(buffer.trim())
      buffer = ''
      continue
    }
    buffer += row[i]
  }
  cells.push(buffer.trim())
  return cells
}

/** A table the parser has recognised, with the line its body starts on. */
interface TableAt {
  header: string[]
  align: CellAlign[]
  start: number
}

/**
 * Whether `lines[i]` starts a table, in either of the two shapes a reply uses.
 *
 * The strict shape has a delimiter row (`|---|---|`), and it is the only one that
 * can carry column alignment. The loose shape is the same table with that row
 * left out — which is what models write most of the time, because the row is
 * decoration to them. A reader that insists on it shows the user a paragraph of
 * pipes, so both shapes are recognised here.
 *
 * The loose shape needs two things before it is believed: at least two lines,
 * and the same cell count on each. Both are what keeps prose out. A sentence
 * with a single pipe is one line; `a | b` followed by `---` is a sentence and a
 * rule, not a one-column table; and a paragraph that happens to contain a pipe
 * on one line does not agree with its neighbours on a count.
 */
function tableAt(lines: string[], i: number): TableAt | null {
  const header = lines[i]
  if (!header?.includes('|')) return null
  const cells = splitRow(header)
  // A row made only of dashes is a delimiter that lost its header, not a
  // header: `|---|---|` at the top of a reply must not become a table of
  // `---` cells.
  if (cells.every((cell) => DELIM_CELL.test(cell))) return null

  const delimiter = lines[i + 1]
  if (delimiter !== undefined) {
    const marks = splitRow(delimiter)
    if (marks.length === cells.length && marks.every((cell) => DELIM_CELL.test(cell))) {
      return { header: cells, align: marks.map(cellAlign), start: i + 2 }
    }
  }

  // The loose shape. One following line is enough for a header and a row, and
  // an exact cell count is the whole guard against reading prose as a grid.
  const row = lines[i + 1]
  if (row === undefined || !row.includes('|')) return null
  if (splitRow(row).length !== cells.length) return null
  return { header: cells, align: cells.map(() => null), start: i + 1 }
}

function cellAlign(cell: string): CellAlign {
  const left = cell.startsWith(':')
  const right = cell.endsWith(':')
  if (left && right) return 'center'
  if (left) return 'left'
  if (right) return 'right'
  return null
}

/** A block found at a line, and the line the next block starts on. */
interface ParsedBlock {
  block: Block
  next: number
}

/**
 * Parses the whole answer into blocks.
 *
 * Line endings are normalised first: a model may send `\r\n`, and a `\r` left
 * on the end of a heading would end up in the text node.
 */
export function parseMarkdown(text: string, streaming = false): Block[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const blocks: Block[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]

    if (!line.trim()) {
      i += 1
      continue
    }

    const fence = parseFence(lines, i)
    if (fence) {
      blocks.push(fence.block)
      i = fence.next
      continue
    }

    const heading = HEADING.exec(line)
    if (heading) {
      blocks.push({
        kind: 'heading',
        level: heading[1].length,
        inlines: parseInline(heading[2], streaming)
      })
      i += 1
      continue
    }

    // Before the list: `---` is a rule, not a bullet whose item is `--`.
    if (RULE.test(line)) {
      blocks.push({ kind: 'rule' })
      i += 1
      continue
    }

    // Before the list: a row `| a | b |` is not a bullet, but a delimiter row
    // that starts with `-` would be read as one.
    const table = parseTable(lines, i, streaming)
    if (table) {
      blocks.push(table.block)
      i = table.next
      continue
    }

    const list = parseList(lines, i, streaming)
    if (list) {
      blocks.push(list.block)
      i = list.next
      continue
    }

    const paragraph = parseParagraph(lines, i, streaming)
    blocks.push(paragraph.block)
    i = paragraph.next
  }

  return blocks
}

/** A fenced code block, closed or still streaming. */
function parseFence(lines: string[], i: number): ParsedBlock | null {
  const fence = FENCE.exec(lines[i])
  if (!fence) return null
  const body: string[] = []
  let next = i + 1
  while (next < lines.length && !CLOSING_FENCE.test(lines[next])) {
    body.push(lines[next])
    next += 1
  }
  // A fence that never closes is what streaming looks like. Stepping over the
  // closing fence when there is none lands past the end, which ends the loop too.
  next += 1
  return { block: { kind: 'code', lang: fence[1], text: body.join('\n') }, next }
}

function parseTable(lines: string[], i: number, streaming: boolean): ParsedBlock | null {
  const table = tableAt(lines, i)
  if (!table) return null
  const rows: Inline[][][] = []
  let next = table.start
  // A row is any non-empty line with a pipe in it. The count is not checked
  // again: a ragged row is a mistake to pad, not a reason to drop the table
  // back into prose.
  while (next < lines.length && lines[next].trim() && lines[next].includes('|')) {
    rows.push(splitRow(lines[next]).map((cell) => parseInline(cell, streaming)))
    next += 1
  }
  return {
    block: {
      kind: 'table',
      align: table.align,
      // A short row is padded and a long one is cut, so the table keeps the
      // shape its header promised instead of leaning on whatever the row
      // happened to contain.
      header: table.header.map((cell) => parseInline(cell, streaming)),
      rows: rows.map((row) => table.header.map((_, column) => row[column] ?? []))
    },
    next
  }
}

function parseList(lines: string[], i: number, streaming: boolean): ParsedBlock | null {
  const line = lines[i]
  const ordered = !BULLET.test(line)
  if (!BULLET.test(line) && !ORDERED.test(line)) return null
  const items: Inline[][] = []
  let next = i
  while (next < lines.length) {
    const item = ordered ? ORDERED.exec(lines[next]) : BULLET.exec(lines[next])
    if (!item) break
    items.push(parseInline((ordered ? item[2] : item[1]).trim(), streaming))
    next += 1
  }
  return {
    block: {
      kind: 'list',
      ordered,
      start: ordered ? Number(ORDERED.exec(line)?.[1] ?? 1) : 1,
      items
    },
    next
  }
}

/** The last resort: consecutive lines that are not another block. */
function parseParagraph(lines: string[], i: number, streaming: boolean): ParsedBlock {
  const paragraph: Inline[][] = []
  let next = i
  while (next < lines.length) {
    const current = lines[next]
    if (!current.trim()) break
    // A block marker ends the paragraph even without a blank line between them:
    // models rarely leave one, and a list swallowed into prose reads as a typo.
    if (paragraph.length > 0 && (startsBlock(current) || tableAt(lines, next))) break
    paragraph.push(parseInline(current.trim(), streaming))
    next += 1
  }
  return { block: { kind: 'paragraph', lines: paragraph }, next }
}

function startsBlock(line: string): boolean {
  return FENCE.test(line) || HEADING.test(line) || RULE.test(line) || BULLET.test(line) || ORDERED.test(line)
}

/**
 * Parses one line of inline markers.
 *
 * Code is matched before emphasis, so `**` inside a code span is literal. Links
 * before bare URLs, so a `[label](url)` is not first eaten by the URL branch.
 */
export function parseInline(text: string, streaming = false): Inline[] {
  const out: Inline[] = []
  let buffer = ''
  let i = 0

  const flush = (): void => {
    if (!buffer) return
    out.push({ kind: 'text', text: buffer })
    buffer = ''
  }

  while (i < text.length) {
    const rest = text.slice(i)
    const char = text[i]

    if (char === '`') {
      const close = rest.indexOf('`', 1)
      if (close > 1) {
        flush()
        out.push({ kind: 'code', text: rest.slice(1, close) })
        i += close + 1
        continue
      }
      buffer += char
      i += 1
      continue
    }

    if (char === '[') {
      const link = LINK.exec(rest)
      if (link) {
        flush()
        out.push({ kind: 'link', text: link[1], href: link[2] })
        i += link[0].length
        continue
      }
    }

    if (rest.startsWith('http://') || rest.startsWith('https://')) {
      const match = URL.exec(rest)
      // Trailing punctuation belongs to the sentence, not to the address. The
      // trimmed tail is left for the next iteration, so it stays a text node.
      const href = match ? trimUrl(match[0]) : ''
      if (href.length > 'https://'.length) {
        flush()
        out.push({ kind: 'link', text: href, href })
        i += href.length
        continue
      }
    }

    if (rest.startsWith('**')) {
      const close = rest.indexOf('**', 2)
      if (close > 2) {
        flush()
        out.push({ kind: 'strong', children: parseInline(rest.slice(2, close), streaming) })
        i += close + 2
        continue
      }
      if (streaming && close === -1 && rest.slice(2).trim()) {
        flush()
        out.push({ kind: 'strong', children: parseInline(rest.slice(2), streaming) })
        i = text.length
        continue
      }
      buffer += '**'
      i += 2
      continue
    }

    if ((char === '*' || char === '_') && opensEmphasis(text, i)) {
      const close = findEmphasisClose(rest, char)
      if (close > 1) {
        flush()
        out.push({ kind: 'em', children: parseInline(rest.slice(1, close), streaming) })
        i += close + 1
        continue
      }
      if (streaming && close === -1 && rest.slice(1).trim()) {
        flush()
        out.push({ kind: 'em', children: parseInline(rest.slice(1), streaming) })
        i = text.length
        continue
      }
    }

    buffer += char
    i += 1
  }

  flush()
  return out
}

/**
 * Whether the marker at `at` can open emphasis.
 *
 * `2 * 3` is arithmetic, not italics: an opener is never followed by a space.
 * An underscore inside a word (`snake_case`) is an identifier, not a marker,
 * which is why it also checks the character before it.
 */
function opensEmphasis(text: string, at: number): boolean {
  const next = text[at + 1]
  if (next === undefined || /\s/.test(next)) return false
  if (text[at] === '_' && at > 0 && LETTER_OR_DIGIT.test(text[at - 1])) return false
  return true
}

/** The index of the marker that closes the emphasis opened at `rest[0]`. */
function findEmphasisClose(rest: string, marker: string): number {
  for (let j = 1; j < rest.length; j += 1) {
    if (rest[j] !== marker) continue
    // The first half of a `**` pair is bold's, not italics'.
    if (marker === '*' && rest[j + 1] === '*') {
      j += 1
      continue
    }
    if (/\s/.test(rest[j - 1])) continue
    if (marker === '_' && LETTER_OR_DIGIT.test(rest[j + 1] ?? '')) continue
    return j
  }
  return -1
}

function trimUrl(url: string): string {
  let end = url.length
  while (end > 0 && '.,;:!?'.includes(url[end - 1])) end -= 1
  return url.slice(0, end)
}
