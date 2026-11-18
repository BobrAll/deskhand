/**
 * The card's copy that is tied to a piece of behaviour rather than to the layout.
 *
 * Text that only a component says lives next to that component; these two are
 * here because they belong to a *direction* — the same two directions the card
 * asks the main process for — and every place that draws a rewrite button has to
 * agree on the wording.
 */

import type { RefineDirection } from '@shared/types'

/**
 * The two rewrite buttons under a finished answer.
 *
 * `label` is what the button says; `hint` is the tooltip, which is where the
 * difference between them is actually explained — "Короче" alone does not say
 * whether the meaning survives.
 */
export const REFINE_LABEL: Record<RefineDirection, string> = {
  shorter: 'Короче',
  longer: 'Длиннее'
}

export const REFINE_HINT: Record<RefineDirection, string> = {
  shorter: 'Сократить ответ, сохранив суть',
  longer: 'Развернуть ответ подробнее'
}
