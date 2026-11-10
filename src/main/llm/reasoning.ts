/**
 * Fields that switch reasoning off for the models that reason by default.
 *
 * OpenRouter has its own switch. The GPT models that accept `reasoning_effort`
 * get it explicitly set to `none`, because omitting the field leaves their
 * default thinking budget on and slows a short answer down. Every other model
 * gets an empty body, so no unsupported parameter is sent to it.
 */
export function disabledReasoning(baseUrl: string, model: string): object {
  if (new URL(baseUrl).hostname === 'openrouter.ai') {
    return { reasoning: { enabled: false } }
  }
  const name = model.split('/').pop() ?? model
  return /^gpt-(?:5\.[1-9]|[6-9])/.test(name)
    ? { reasoning_effort: 'none' }
    : {}
}
