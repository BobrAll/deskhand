/**
 * The card's rewrite buttons, pinned.
 *
 * Both strings are on screen and both are read before the button is pressed: the
 * label says which way the answer goes, the tooltip says what the direction keeps
 * and what it drops. A change here is a change to what the person is promised, so
 * it is a test and not a diff nobody notices.
 */

import { describe, expect, it } from 'vitest'
import { REFINE_HINT, REFINE_LABEL } from './copy'

describe('copy: the rewrite buttons', () => {
  it('labels both directions and explains them in the tooltip', () => {
    expect(REFINE_LABEL).toEqual({ shorter: 'Короче', longer: 'Длиннее' })
    expect(REFINE_HINT.shorter).toBe('Сократить ответ, сохранив суть')
    expect(REFINE_HINT.longer).toBe('Развернуть ответ подробнее')
  })
})
