/** Entry point for the transparent field-highlight layer. */

import './highlight.css'

const root = document.getElementById('root')
if (!root) throw new Error('root element is missing')

window.deskhand.voice.onFieldHighlight((event) => {
  root.dataset.visible = event.visible ? 'true' : 'false'
})
