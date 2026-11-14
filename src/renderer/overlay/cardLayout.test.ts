/**
 * The card's width, without a card.
 *
 * Every case below is one the eye used to check: the narrow card that opens on
 * the first keystroke, the line that wraps at the point the card stops growing,
 * the stop button that takes its own points off the line, and the answer that is
 * wider than the card without widening it past the content cap. Widths are the
 * one part of the card that is arithmetic rather than style, so a regression here
 * is silent — the card just looks wrong.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CARD_NARROW_WIDTH, CARD_VOICE_WIDTH, CARD_WIDTH } from '@shared/metrics'
import {
  AGENT_ROW_CHROME,
  AGENT_STATUS_INSET,
  ANSWER_CHROME,
  CARET_SLACK,
  CHROME_WIDTH,
  STOP_CHROME
} from './cardMetrics'
import { layoutCard, type CardLayoutInput } from './cardLayout'

/** Ten points per character, so a measured line is its own length times ten. */
const POINTS_PER_CHAR = 10

beforeEach(() => {
  vi.stubGlobal('document', {
    createElement: () => ({
      getContext: () => ({
        font: '',
        measureText: (text: string) => ({ width: text.length * POINTS_PER_CHAR })
      })
    })
  })
})

/** A card with nothing on it: no question, no answer, no agent row. */
function input(overrides: Partial<CardLayoutInput> = {}): CardLayoutInput {
  return {
    prompt: '',
    font: '13px test',
    answer: '',
    hasAnswer: false,
    busy: false,
    speaking: false,
    agentStatus: null,
    agentRunning: false,
    listening: false,
    wantsWide: false,
    userWidth: null,
    availWidth: 1440,
    ...overrides
  }
}

describe('layoutCard: the question', () => {
  it('opens at the narrow width while the field is empty', () => {
    const card = layoutCard(input())

    expect(card.width).toBe(CARD_NARROW_WIDTH)
    expect(card.wrapped).toBe(false)
  })

  it('grows by the measured line, chrome included', () => {
    const prompt = 'Где настройки?'
    const card = layoutCard(input({ prompt }))

    expect(card.width).toBe(prompt.length * POINTS_PER_CHAR + CHROME_WIDTH + CARET_SLACK)
    expect(card.wrapped).toBe(false)
  })

  it('takes the stop button off the line while a request runs', () => {
    const prompt = 'Где настройки?'
    const idle = layoutCard(input({ prompt }))
    const busy = layoutCard(input({ prompt, busy: true }))

    expect(busy.width - idle.width).toBe(STOP_CHROME)
  })

  it('stops at the content cap and wraps the question there', () => {
    const card = layoutCard(input({ prompt: 'а'.repeat(60) }))

    expect(card.width).toBe(CARD_WIDTH)
    expect(card.wrapped).toBe(true)
  })

  it('wraps sooner in a card the user dragged narrow', () => {
    const prompt = 'а'.repeat(20)
    const roomy = layoutCard(input({ prompt, userWidth: CARD_WIDTH }))
    const narrow = layoutCard(input({ prompt, userWidth: CARD_NARROW_WIDTH }))

    expect(roomy.wrapped).toBe(false)
    expect(narrow.wrapped).toBe(true)
  })
})

describe('layoutCard: the answer', () => {
  it('reports what the answer wants, uncapped, so «Шире» has a target', () => {
    const answer = 'я'.repeat(100)
    const card = layoutCard(input({ answer, hasAnswer: true }))

    expect(card.naturalWidth).toBe(answer.length * POINTS_PER_CHAR + ANSWER_CHROME + CARET_SLACK)
    // The card itself stays at the cap: only the user's drag goes past it.
    expect(card.width).toBe(CARD_WIDTH)
    // A long answer does not wrap the question, which is not on the line.
    expect(card.wrapped).toBe(false)
  })

  it('lets the user width win over the content, answered or not', () => {
    const chosen = 500
    const card = layoutCard(input({ answer: 'Ответ.', hasAnswer: true, userWidth: chosen }))

    expect(card.width).toBe(chosen)
  })

  it('keeps the answer width out of the number when there is no answer', () => {
    const blank = layoutCard(input({ answer: '   ', hasAnswer: false }))

    expect(blank.naturalWidth).toBe(CARD_NARROW_WIDTH)
  })
})

describe('layoutCard: the rest of the card', () => {
  it('opens to the full width for the drawer and the waiting row', () => {
    expect(layoutCard(input({ wantsWide: true })).width).toBe(CARD_WIDTH)
  })

  it('gives a voice turn the bars width and nothing else', () => {
    expect(layoutCard(input({ listening: true, wantsWide: true })).width).toBe(CARD_VOICE_WIDTH)
  })

  it('measures the agent row in its own font and inset', () => {
    const agentStatus = 'Нажимаю «Экспорт»'
    const still = layoutCard(input({ agentStatus, agentRunning: false }))
    const running = layoutCard(input({ agentStatus, agentRunning: true }))
    const measured = agentStatus.length * POINTS_PER_CHAR + AGENT_ROW_CHROME + CARET_SLACK

    expect(still.width).toBe(measured + AGENT_STATUS_INSET)
    expect(running.width).toBe(measured)
  })
})
