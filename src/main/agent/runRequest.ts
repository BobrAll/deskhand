import { AGENT_MIN_OUTPUT_TOKENS } from '@shared/defaults'
import type { AgentProvider } from './sidecarProtocol'

/** One earlier question and the answer it got, as the agent reads it. */
export interface AgentExchange {
  question: string
  answer: string
}

/** What one run needs to know: the request, where it started, and the model. */
export interface AgentRunInput {
  /** What the user asked for, in their words. */
  prompt: string
  /** The app the card was opened in, as a hint about where to look first. */
  appName: string | null
  windowTitle: string | null
  /**
   * What was said before this request, oldest first.
   *
   * «Сделай» is a complete request only in the sentence it answers. The writer
   * already gets these turns, so a follow-up there means something; without
   * them here the same follow-up reaches the agent as a verb with no object,
   * and the only honest answer it can give is to ask what to do. Passing them
   * is what makes the agent part of the same conversation rather than a fresh
   * one that happens to start mid-sentence.
   */
  history?: AgentExchange[]
  /** The model the user configured, with the key only the main process holds. */
  provider: AgentProvider
  /** Bundle ids the agent must never read or act on. */
  excludedApps?: string[]
}

/**
 * The provider settings, with enough output room for an agent step.
 *
 * `maxTokens` is the writer's number: it was picked for prose, where 1024 is a
 * generous answer. An agent step is a different shape — a sentence of reasoning
 * wrapped around a tool call whose arguments are nested JSON — and at 1024 the
 * reply gets cut off mid-call. The half-written call parses into no calls at all,
 * so the step arrives as an empty message and the run is thrown away.
 *
 * The floor is applied here rather than by changing the setting, so the writer
 * keeps its own budget and an existing 1024 in the user's settings cannot
 * resurrect the failure.
 */
export function withAgentBudget(provider: AgentProvider): AgentProvider {
  if (provider.maxTokens >= AGENT_MIN_OUTPUT_TOKENS) return provider
  return { ...provider, maxTokens: AGENT_MIN_OUTPUT_TOKENS }
}

/**
 * How much of one earlier turn the agent needs.
 *
 * The whole point of the block is the noun the current request leaves out, and
 * that noun is almost always in the first sentences. The card already trims its
 * history; this is the second ceiling, because a long answer would otherwise be
 * paid for on every step of the run, not once.
 */
const HISTORY_TURN_CHARS = 900

/**
 * The task, as the agent reads it.
 *
 * The prompt is the request; the app and the window are where to look first. They
 * are stated as context and not as instructions on purpose — the agent decides
 * which app to touch by calling `get_app_state`, and telling it "the answer is in
 * this window" would be the host making a decision the screen is better placed to
 * make.
 *
 * Earlier turns are quoted only when there are some, and labelled as context: a
 * bare «сделай» has no meaning on its own, but the same word after «можно ли
 * ...? если да — сделай» does. The block is closed with «Текущая задача» so a
 * past request, still full of imperatives, is not read as one to act on now.
 */
export function taskText(input: AgentRunInput): string {
  const lines: string[] = []
  if (input.appName) lines.push(`Приложение: ${input.appName}`)
  if (input.windowTitle) lines.push(`Окно: ${input.windowTitle}`)
  if (lines.length > 0) lines.push('')

  const history = input.history?.filter((entry) => entry.question.trim()) ?? []
  if (history.length > 0) {
    lines.push('Разговор до этого — контекст, чтобы понять, к чему относится текущая просьба:')
    for (const entry of history) {
      lines.push(`Пользователь: ${clipHistory(entry.question)}`)
      if (entry.answer.trim()) lines.push(`Ответ: ${clipHistory(entry.answer)}`)
    }
    lines.push('')
    lines.push('Текущая задача:')
  }

  lines.push(input.prompt.trim())
  return lines.join('\n')
}

function clipHistory(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > HISTORY_TURN_CHARS ? `${line.slice(0, HISTORY_TURN_CHARS - 1)}…` : line
}
