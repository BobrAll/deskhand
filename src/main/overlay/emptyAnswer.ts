/** Final-turn safeguard; intermediate observation rounds may legitimately be empty. */
export function emptyAnswerFallback(text: string, annotations: number): string {
  if (text.trim() || annotations > 0) return ''
  return 'Не удалось выполнить запрос: ответ и отметки на экране не получены. Попробуйте уточнить, что нужно найти или показать.'
}
