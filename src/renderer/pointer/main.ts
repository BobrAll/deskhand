/**
 * The transparent drawing layer's entry point.
 *
 * This renderer is deliberately tiny: no app state, no IPC beyond listening for
 * shapes, no React needed for what is ultimately a handful of SVG paths. Less
 * moving parts also means the arrow appears at the same frame the model asked for
 * it, without a reconciliation pass getting in the way.
 */

import './pointer.css'
import { render } from './draw'
import type { PointerPayload } from '@shared/types'

const root = document.getElementById('root')
if (!root) throw new Error('root element is missing')

window.smartCursor.pointer.onDraw((payload: PointerPayload) => {
  render(root, payload)
})
