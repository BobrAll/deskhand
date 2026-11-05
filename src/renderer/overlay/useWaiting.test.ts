import { afterEach, expect, it, vi } from 'vitest'

let cleanup: (() => void) | undefined
const update = vi.fn()
vi.mock('react', () => ({
  useState: (value: unknown) => [value, update],
  useEffect: (effect: () => (() => void) | undefined) => { cleanup = effect() }
}))
import { useWaiting } from './useWaiting'
import { waitingStage } from './waiting'

afterEach(() => { cleanup?.(); cleanup = undefined; update.mockClear(); vi.useRealTimers() })

it('shows status, one tip, then a long-wait message on the same request', () => {
  vi.useFakeTimers()
  useWaiting('one', true)
  expect(waitingStage(update.mock.lastCall![0].elapsed)).toBe('quiet')
  vi.advanceTimersByTime(1500)
  expect(waitingStage(update.mock.lastCall![0].elapsed)).toBe('status')
  vi.advanceTimersByTime(6500)
  expect(waitingStage(update.mock.lastCall![0].elapsed)).toBe('tip')
  const tip = update.mock.lastCall![0].tip
  vi.advanceTimersByTime(17000)
  expect(waitingStage(update.mock.lastCall![0].elapsed)).toBe('long')
  expect(update.mock.lastCall![0].tip).toBe(tip)
})

it('cleans timers on completion, cancellation or replacement of the request', () => {
  vi.useFakeTimers()
  useWaiting('old', true)
  cleanup?.()
  update.mockClear()
  vi.advanceTimersByTime(30000)
  expect(update).not.toHaveBeenCalled()
  expect(useWaiting(null, false)).toEqual({ elapsed: 0, tip: '' })
  expect(update).not.toHaveBeenCalled()
})
