/** Entry point for the transparent field-highlight layer. */

import './highlight.css'

const root = document.getElementById('root')
const bars = document.querySelector('.field-voice-bars')
if (!root || !bars) throw new Error('highlight root is missing')

// The field becomes a small voice surface, so the bar count has to work for a
// narrow search box as well as for a wide editor.
for (let index = 0; index < 9; index += 1) {
  const bar = document.createElement('i')
  bar.style.animationDelay = `${(index * 73) % 420}ms`
  bar.style.animationDuration = `${700 + (index % 4) * 80}ms`
  bars.append(bar)
}

window.deskhand.voice.onFieldHighlight((event) => {
  root.dataset.visible = event.visible ? 'true' : 'false'
  // The animation already bounces; the level opens the whole cluster, the same
  // way the cursor bars respond to the microphone.
  root.style.setProperty('--amp', (0.65 + event.level * 0.35).toFixed(3))
})
