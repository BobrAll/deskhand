/** Entry point for the transparent field-highlight layer. */

import './highlight.css'

const rootNode = document.getElementById('root')
const barNode = document.querySelector('.field-voice-bars')
if (!rootNode || !barNode) throw new Error('highlight root is missing')
const root = rootNode
const bars = barNode

/**
 * One bar every ~10 CSS pixels, so a wide editor gets a dense waveform instead
 * of the same handful of bars stretched across it. The cap keeps an unusually
 * wide field from creating thousands of nodes.
 */
const BAR_SPACING_PX = 10
const MIN_BARS = 6
const MAX_BARS = 120
let barCount = 0

function layoutBars(): void {
  const width = Math.max(80, window.innerWidth)
  const next = Math.max(
    MIN_BARS,
    Math.min(MAX_BARS, Math.floor((width - 16) / BAR_SPACING_PX))
  )
  if (next === barCount) return
  barCount = next
  bars.replaceChildren(
    ...Array.from({ length: next }, (_, index) => {
      const bar = document.createElement('i')
      bar.style.animationDelay = `${(index * 73) % 420}ms`
      bar.style.animationDuration = `${700 + (index % 4) * 80}ms`
      return bar
    })
  )
}

layoutBars()
window.addEventListener('resize', layoutBars)

window.deskhand.voice.onFieldHighlight((event) => {
  root.dataset.visible = event.visible ? 'true' : 'false'
  // The field is resized to the target control before the first event; the
  // resize listener normally has done this already, but a late layout must not
  // leave the previous field's bar count on a new, wider box.
  layoutBars()
  // The animation already bounces; the level opens the whole cluster, the same
  // way the cursor bars respond to the microphone.
  root.style.setProperty('--amp', (0.65 + event.level * 0.35).toFixed(3))
})
