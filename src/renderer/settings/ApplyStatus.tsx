/**
 * The one line that replaces the save button.
 *
 * With nothing to save it says nothing: a footer that permanently announces
 * "Применено" trains people to stop reading it, and the whole point of removing
 * the button is that the state has to be believable without being checked.
 *
 * The mapping from state to words is a pure function so it can be checked without
 * mounting the window — the wording is the whole feature here, and "held" printing
 * the generic "не применено" instead of the reason is the difference between a
 * window that explains itself and one that sulks.
 */

/**
 * Where a change is on its way to disk.
 *
 * The window has no «Сохранить»: everything is written as it is edited. That
 * removes a whole class of "я же поставил галочку" bugs, but it also means the
 * footer has to be honest about the three states that are not "done" — a change
 * still waiting for the debounce, one that is in flight, and one the settings
 * themselves refuse (an invalid base URL, an empty prompt field).
 */
export type ApplyState = 'idle' | 'pending' | 'saving' | 'saved' | 'held' | 'error'

export interface ApplyStatusText {
  /** The line itself. */
  text: string
  /** Whether it reads as a problem. */
  isProblem: boolean
}

/** What the footer says for a given state, or `null` when it says nothing. */
export function applyStatusText(state: ApplyState, holdReason: string | null): ApplyStatusText | null {
  if (state === 'idle') return null

  if (state === 'pending') return { text: 'Применяю…', isProblem: false }
  if (state === 'saving') return { text: 'Сохраняю…', isProblem: false }
  if (state === 'saved') return { text: 'Применено', isProblem: false }
  if (state === 'held') return { text: holdReason ?? 'Изменения не применены', isProblem: true }
  return { text: 'Не применено — попробуй ещё раз', isProblem: true }
}

export function ApplyStatus(props: { state: ApplyState; holdReason: string | null }) {
  const status = applyStatusText(props.state, props.holdReason)
  if (!status) return null

  return (
    <span className={`status ${status.isProblem ? 'err' : 'ok'}`} title={props.holdReason ?? undefined} role="status">
      {status.text}
    </span>
  )
}
