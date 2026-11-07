/** Entry point for the agent’s transparent display layer. */

import './cursor.css'
import { createCursor } from './cursor'
import type { AgentCursorFrame } from '@shared/types'

const root = document.getElementById('root')
if (!root) throw new Error('root element is missing')

const cursor = createCursor(root)

window.smartCursor.agentCursor.onState((frame: AgentCursorFrame) => {
  cursor.render(frame)
})
