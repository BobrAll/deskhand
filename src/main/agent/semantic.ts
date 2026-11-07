/**
 * Turning a plan step into a semantic request, and deciding what to do with the
 * answer.
 *
 * The visual path answers "where did the model point?" and then corrects that
 * guess against the Accessibility tree. This module answers the other question —
 * "which control did the model *name*?" — so the action can be performed on the
 * control itself. Three rules keep it from being a guess under a new name:
 *
 * **1. A semantic request needs a name.** A click carries the `«…»` label the
 * model wrote. Without one there is nothing to look up, and a query built from a
 * coordinate would be a coordinate click wearing a role. Such a step keeps the
 * visual path.
 *
 * **2. Only reversible, intent-carrying actions qualify.** `press` on a named
 * control and typing into a named field are what the user asked for. Dragging,
 * scrolling and shortcuts have no semantic equivalent here, and `setValue` —
 * which replaces a field wholesale — is not offered at all: typing is, because
 * inserting at the caret is what "впиши" means.
 *
 * **3. A refusal falls back; a performed action never does.** The distinction is
 * the whole safety property of this path. If the service says it pressed the
 * button and the application confirmed it, repeating the click would be a second
 * click. If it says the control was not found, nothing happened, and the pixel
 * the model gave is still the best remaining evidence.
 *
 * Pure module: no Electron, no Node, no I/O.
 */

import type { AgentPlanStep } from '@shared/types'
import type { CuActionKind, CuActionResult } from './computerUse'

export interface SemanticStep {
  /**
   * The name to resolve, not a finished query.
   *
   * Which protocol field expresses that name is the client's problem, not this
   * module's: `title` and `ariaLabel` are exact matches, `text` is a substring
   * match that goes ambiguous on ordinary labels like «Назад». Keeping the name
   * here lets the client try them in order of strength.
   */
  name: string
  action: CuActionKind
  /** The role the probe saw under the point, used to narrow the loose match. */
  role?: string
  /** One line for the card, so the run reads the same whatever path it took. */
  label: string
}

export interface SemanticContext {
  /**
   * The step before this one, when it was a click that named a field.
   *
   * `@type` has no coordinates of its own — it goes to whatever has focus — so
   * the only way to address the field is to remember which control the plan
   * clicked just before. That is exactly what the plan means: "click the search
   * box, then type the query".
   */
  previous?: AgentPlanStep | null
  /**
   * Whether the Accessibility probe found the aimed element to be a text field.
   *
   * A press on a text field is not what clicking it does — clicking focuses it —
   * so this decides between `press` and `focus`.
   */
  element?: { role?: string; editable?: boolean } | null
}

/** Roles that take text; the same set the targeting module recognises. */
const FIELD_ROLES = new Set(['AXTextField', 'AXTextArea', 'AXComboBox', 'AXSearchField'])

/** A label shorter than this is a letter, not a name worth matching on. */
const MIN_LABEL = 2

/** The service's `text` field is a substring match, so it must be the whole name. */
export function normalizeLabel(raw: string | undefined | null): string | null {
  if (!raw) return null
  const text = raw
    .replace(/[«»"“”]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (text.length < MIN_LABEL) return null
  return text
}

function isField(element: SemanticContext['element']): boolean {
  if (!element) return false
  if (element.editable) return true
  return typeof element.role === 'string' && FIELD_ROLES.has(element.role)
}

/**
 * The semantic version of a step, or null when the step has none.
 *
 * A `click` becomes `press` — or `focus` when the thing under the point is a
 * text field, because that is what clicking it does. A `type` becomes `typeText`
 * on the field the previous step named.
 */
export function semanticFor(step: AgentPlanStep, context: SemanticContext = {}): SemanticStep | null {
  const { action } = step
  // The role the probe saw under the point is only a hint for narrowing a loose
  // match. It is carried, never required: the model's point is the part that
  // drifts, so a role read from the wrong element must not veto the right one.
  const role = typeof context.element?.role === 'string' ? context.element.role : undefined

  if (action.kind === 'click') {
    const name = normalizeLabel(action.label)
    if (!name) return null
    // A double click is a distinct gesture — open a file, select a word — and a
    // semantic press has no equivalent. It stays on the visual path.
    if (action.button === 'double') return null
    if (isField(context.element)) {
      return { name, role, action: { kind: 'focus' }, label: `Фокус: «${name}»` }
    }
    return { name, role, action: { kind: 'press' }, label: `Нажатие: «${name}»` }
  }

  if (action.kind === 'type') {
    const previous = context.previous
    if (!previous || previous.action.kind !== 'click') return null
    if (previous.action.button === 'double') return null
    const field = normalizeLabel(previous.action.label)
    if (!field) return null
    return {
      name: field,
      action: { kind: 'typeText', text: action.text },
      label: `Ввод в «${field}»`
    }
  }

  return null
}

export type SemanticVerdict =
  /** The service performed it. Never retry it on the visual path. */
  | { kind: 'done'; verified: boolean }
  /** Nothing changed on the target: the pixel is still the best evidence left. */
  | { kind: 'fallback'; reason: string }

/**
 * What to do with the service's answer.
 *
 * `performedUnverified` counts as done, not as a failure. It means the call
 * succeeded and the application showed no observable change — a press that
 * opened a menu the observer could not see, or a control that reacts in a way
 * the Accessibility API does not announce. Repeating it as a coordinate click
 * would press the button twice, which is worse than not proving it happened.
 */
export function readResult(result: CuActionResult): SemanticVerdict {
  switch (result.outcome) {
    case 'verified':
    case 'verifiedAfterRetry':
      return { kind: 'done', verified: true }
    case 'performedUnverified':
      return { kind: 'done', verified: false }
    default:
      return { kind: 'fallback', reason: result.outcome }
  }
}

/**
 * What to do with a thrown call.
 *
 * Every failure falls back: an unavailable service, a permission problem and a
 * refused target all leave the application exactly as it was, so the visual path
 * loses nothing by trying. The one thing this must never do is treat a throw as
 * evidence that the action did not happen — a timeout after the service posted
 * the click is genuinely unknown, and the caller is told which case it is by the
 * error's `reason`.
 */
export function readError(error: unknown): { kind: 'fallback'; reason: string; uncertain: boolean } {
  const reason = typeof (error as { reason?: unknown })?.reason === 'string'
    ? String((error as { reason: string }).reason)
    : typeof (error as { code?: unknown })?.code === 'number'
      ? `rpc-${(error as { code: number }).code}`
      : 'unknown'
  // A timeout may have been delivered after the click was posted.
  return { kind: 'fallback', reason, uncertain: reason === 'timeout' }
}
