/**
 * The bubble's entry point.
 *
 * Like the drawing layer, this page has no framework and no app state: it exists
 * to render one small, fast-changing picture at the cursor, and every frame it
 * receives is a complete description of that picture. React's reconciliation
 * would only add work to the path the user is watching for smoothness.
 */

import './hud.css'
import { createHud } from './hud'
import type { HudFrame } from '@shared/types'

const root = document.getElementById('root')
if (!root) throw new Error('root element is missing')

const hud = createHud(root)

window.smartCursor.hud.onState((frame: HudFrame) => {
  hud.render(frame)
})

// The window is prewarmed, so its page can finish loading *after* a turn has
// already started; without this pull that first turn would show an empty bubble.
void window.smartCursor.hud.getState().then((frame) => {
  if (frame) hud.render(frame)
})
