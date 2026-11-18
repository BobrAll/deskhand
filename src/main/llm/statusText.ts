/**
 * What an HTTP status means to the person reading it.
 *
 * Two callers used to keep their own copy: the chat request (`http.ts`) and the
 * "Проверить ключ" probe (`testKey.ts`). They drifted in the way that matters —
 * the same key could pass the probe and fail the request with a different
 * sentence for the same status, and the probe's table did not know about a
 * context that is too large, because its own request never sends one.
 *
 * The one difference that is real stays a parameter: a 404 from the probe means
 * the base URL does not point at an API root, while a 404 from a chat request
 * means the model name is wrong. Same status, different question being asked.
 */

export interface StatusText {
  message: string
  /** Whether trying the same request again could succeed. */
  retryable: boolean
}

export interface StatusContext {
  /** The provider as the user sees it ("OpenAI", "OpenRouter"). */
  label: string
  /** The provider's own words, when it gave any. */
  detail?: string
  /** True for the key probe: it asks whether the endpoint exists, not whether the model does. */
  probe?: boolean
}

export function describeProviderStatus(status: number, context: StatusContext): StatusText {
  const { label, detail = '', probe = false } = context
  const suffix = detail ? ` (${detail})` : ''

  switch (status) {
    case 401:
    case 403:
      return { message: `Ключ ${label} не принят. Проверь ключ в настройках.`, retryable: false }
    case 402:
      // True in both contexts: the key was accepted, the account cannot pay.
      return {
        message: `Ключ ${label} действителен, но на счёте нет средств.`,
        retryable: false
      }
    case 404:
      return probe
        ? {
            message: 'Сервис ответил 404: проверь base URL (нужен корень API, например …/v1).',
            retryable: false
          }
        : {
            message: `Модель не найдена у ${label}. Проверь название модели.${suffix}`,
            retryable: false
          }
    case 413:
      return {
        message: 'Контекст слишком большой: уменьши скриншот или выделение.',
        retryable: false
      }
    case 429:
      return {
        message: `Ключ ${label} действителен, но лимит запросов исчерпан. Попробуй позже.`,
        retryable: true
      }
    default:
      if (status >= 500) {
        return {
          message: `Сервис ${label} временно недоступен (${status}).`,
          retryable: true
        }
      }
      return {
        message: `Ошибка ${label} (${status})${detail ? `: ${detail}` : ''}`,
        retryable: true
      }
  }
}
