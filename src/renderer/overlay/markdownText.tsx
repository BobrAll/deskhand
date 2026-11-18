/**
 * The answer, printed from the tokens `markdown.ts` produces.
 *
 * Every node here is a React element, so a reply is never interpreted as HTML.
 * The caret lives inside the last block rather than after it: a block element
 * is a box, and a caret appended to the container would drop onto a line of its
 * own the moment the answer had a paragraph in it.
 */

import { useMemo } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { parseMarkdown, type Block, type CellAlign, type Inline } from './markdown'

/** The blinking cursor, keyed because it is always appended to an array of runs. */
function caretNode(): ReactNode {
  return <span key="caret" className="caret" />
}

function renderInline(nodes: Inline[], withCaret?: boolean): ReactNode[] {
  const rendered = nodes.map((node, index) => {
    switch (node.kind) {
      case 'text':
        return node.text
      case 'code':
        return <code key={index}>{node.text}</code>
      case 'strong':
        return <strong key={index}>{renderInline(node.children)}</strong>
      case 'em':
        return <em key={index}>{renderInline(node.children)}</em>
      case 'link':
        return (
          <a key={index} href={node.href} target="_blank" rel="noreferrer">
            {node.text}
          </a>
        )
    }
  })
  return withCaret ? [...rendered, caretNode()] : rendered
}

/** Paragraph lines keep their break: a newline in an answer is deliberate. */
function renderLines(lines: Inline[][], withCaret?: boolean): ReactNode[] {
  const rendered: ReactNode[] = []
  lines.forEach((line, index) => {
    if (index > 0) rendered.push('\n')
    rendered.push(...renderInline(line, index === lines.length - 1 && withCaret))
  })
  return rendered
}

function renderBlock(block: Block, key: number, withCaret: boolean): ReactNode {
  switch (block.kind) {
    case 'paragraph':
      return <p key={key}>{renderLines(block.lines, withCaret)}</p>
    case 'heading':
      return (
        <p key={key} className="md-heading" data-level={block.level}>
          {renderInline(block.inlines, withCaret)}
        </p>
      )
    case 'list': {
      const items = block.items.map((item, index) => (
        <li key={index}>{renderInline(item, withCaret && index === block.items.length - 1)}</li>
      ))
      return block.ordered ? (
        <ol key={key} start={block.start}>
          {items}
        </ol>
      ) : (
        <ul key={key}>{items}</ul>
      )
    }
    case 'code':
      return (
        <pre key={key}>
          <code>
            {block.text}
            {withCaret && caretNode()}
          </code>
        </pre>
      )
    case 'rule':
      return <hr key={key} />
    case 'table':
      return (
        // Wrapped, not styled directly: a `display: block` table loses its own
        // layout, so the horizontal scroll has to live on a container.
        <div className="md-table" key={key}>
          <table>
            <thead>
              <tr>
                {block.header.map((cell, column) => (
                  <th key={column} style={alignStyle(block.align[column])}>
                    {/* A table that has arrived as far as its delimiter row has
                        no body to hang the caret on, so it goes in the header. */}
                    {renderInline(cell, withCaret && block.rows.length === 0 && column === block.header.length - 1)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {row.map((cell, column) => (
                    <td key={column} style={alignStyle(block.align[column])}>
                      {/* The caret follows the last cell of the last row, so a
                          streaming table keeps it where the text is. */}
                      {renderInline(cell, withCaret && rowIndex === block.rows.length - 1 && column === row.length - 1)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )
  }
}

function alignStyle(align: CellAlign): CSSProperties | undefined {
  return align ? { textAlign: align } : undefined
}

export function Markdown({
  text,
  streaming = false,
  caret = false
}: {
  text: string
  /** Draw unclosed markers as formatting to the end of the line. */
  streaming?: boolean
  /** Put the blinking caret after the last character of the answer. */
  caret?: boolean
}): ReactNode {
  // The card re-renders for reasons that have nothing to do with the text — a
  // width drag, the caret blinking, a notice — and parsing the whole answer
  // again on each of them is work that produces the identical tree.
  const blocks = useMemo(() => parseMarkdown(text, streaming), [text, streaming])
  return <>{blocks.map((block, index) => renderBlock(block, index, caret && index === blocks.length - 1))}</>
}
