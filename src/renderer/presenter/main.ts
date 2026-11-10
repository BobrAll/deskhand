/** Entry point for the agent's virtual-pointer layer. */

import './presenter.css'
import { createPresenter } from './presenter'
import type { AgentPointerFrame } from '@shared/types'

const root = document.getElementById('root')
if (!root) throw new Error('root element is missing')

const presenter = createPresenter(root)

window.smartCursor.agentPresenter.onState((frame: AgentPointerFrame) => {
  presenter.render(frame)
})
