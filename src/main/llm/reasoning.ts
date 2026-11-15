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
  return /^gpt-(?:5\.[1-9]|[6-9])/.test(modelName(model)) ? { reasoning_effort: 'none' } : {}
}

/** The model's own name: an OpenRouter vendor prefix (`openai/gpt-5`) is not part of it. */
function modelName(model: string): string {
  return model.split('/').pop() ?? model
}

/**
 * Whether the model is one of OpenAI's reasoning models.
 *
 * The o-series and the gpt-5 family reject `max_tokens` — their limit travels as
 * `max_completion_tokens` — and reject any `temperature` other than the default,
 * so the chat request must leave both out for them.
 */
export function isReasoningModel(model: string): boolean {
  return /^(?:o[1-9]|gpt-[5-9])(?:[.-]|$)/.test(modelName(model))
}
