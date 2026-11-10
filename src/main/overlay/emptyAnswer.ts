/** Final-turn safeguard; intermediate observation rounds may legitimately be empty. */
export function emptyAnswerFallback(text: string, annotationCount: number): string {
  if (text.trim() || annotationCount > 0) return ''
  return 'Не удалось выполнить запрос: ответ и отметки на экране не получены. Попробуйте уточнить, что нужно найти или показать.'
}
