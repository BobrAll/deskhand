/** Plain text for speech; never read executable instructions or markup aloud. */
export function speechText(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, '')
    .replace(/^\s*@\w+.*$/gm, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/^\s*\|.*\|\s*$/gm, '')
    .replace(/^\s*(?:#{1,6}\s+|[-*+]\s+|>\s*)/gm, '')
    .replace(/[*_`~]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export function requestedReading(prompt: string): boolean {
  return /прочитай|зачитай|озвучь|вслух|read aloud/i.test(prompt)
}

export function automaticSpeech(prompt: string, answer: string, failed = false): string {
  const clean = speechText(answer)
  if (requestedReading(prompt)) return clean
  // Text creation and editing are reviewed visually. Media should start quietly.
  if (!failed && /напиши|перепиши|исправь|переведи|сократи|ответь на|напечатай|вставь|впиши|набери/i.test(prompt)) return ''
  if (!failed && /(?:включи|запусти|воспроизведи|открой).*(?:видео|музык|песн|ролик|подкаст)/i.test(prompt)) return ''
  const sentences = clean.match(/[^.!?]+(?:[.!?]+|$)/g) ?? []
  let result = ''
  for (const sentence of sentences.slice(0, 3)) {
    if ((result + sentence).length > 420) break
    result += sentence
  }
  // Don't cut a sentence into a misleading half-statement.
  if (!result.trim() && clean) return 'Ответ готов. Подробности в карточке.'
  return result.trim()
}
