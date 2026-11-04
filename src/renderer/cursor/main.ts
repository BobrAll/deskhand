/**
 * The cursor highlight's entry point.
 *
 * Like the drawing layer and the listening chip, this page has no framework and
 * no app state: it exists to render one small, fast-changing picture at the
 * pointer, and every frame it receives is a complete description of that picture.
 * The main process owns the window and the follow loop; this module only moves
 * the ring and writes the caption.
 */

import './cursor.css'
import { createCursor } from './cursor'
import type { AgentCursorFrame } from '@shared/types'

const root = document.getElementById('root')
if (!root) throw new Error('root element is missing')

const cursor = createCursor(root)

window.smartCursor.agentCursor.onState((frame: AgentCursorFrame) => {
  cursor.render(frame)
})
