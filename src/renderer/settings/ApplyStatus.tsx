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

export type ApplyState = 'idle' | 'pending' | 'saving' | 'saved' | 'held' | 'error'

export interface ApplyStatusText {
  /** The line itself. */
  text: string
  /** Whether it reads as a problem. */
  bad: boolean
}

/** What the footer says for a given state, or `null` when it says nothing. */
export function applyStatusText(
  state: ApplyState,
  holdReason: string | null
): ApplyStatusText | null {
  if (state === 'idle') return null

  if (state === 'pending') return { text: 'Применяю…', bad: false }
  if (state === 'saving') return { text: 'Сохраняю…', bad: false }
  if (state === 'saved') return { text: 'Применено', bad: false }
  if (state === 'held') return { text: holdReason ?? 'Изменения не применены', bad: true }
  return { text: 'Не применено — попробуйте ещё раз', bad: true }
}

export function ApplyStatus(props: { state: ApplyState; holdReason: string | null }) {
  const status = applyStatusText(props.state, props.holdReason)
  if (!status) return null

  return (
    <span
      className={`status ${status.bad ? 'err' : 'ok'}`}
      title={props.holdReason ?? undefined}
      role="status"
    >
      {status.text}
    </span>
  )
}
