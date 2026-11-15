/**
 * The accelerator a modifier-only hold should commit.
 *
 * The key-up event is the only place that can still name a modifier Chromium
 * never delivered as its own keydown (Fn is the usual one), so the held set and
 * the event's current modifiers are unioned. One modifier is ordinary typing,
 * not a gesture.
 */
export function modifierHold(held: string[], current: string[]): string | null {
  const pressed = [...new Set([...held, ...current])]
  return pressed.length >= 2 ? pressed.join('+') : null
}
