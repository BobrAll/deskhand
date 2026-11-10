/** Do not send unsupported reasoning parameters to ordinary chat models. */
export function disabledReasoning(baseUrl: string, model: string): object {
  if (new URL(baseUrl).hostname === 'openrouter.ai') {
    return { reasoning: { enabled: false } }
  }
  const name = model.split('/').pop() ?? model
  return /^gpt-(?:5\.[1-9]|[6-9])/.test(name)
    ? { reasoning_effort: 'none' }
    : {}
}
