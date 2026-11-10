/**
 * Mapping the helper's Accessibility answers into `AxElementInfo`.
 *
 * The helper prints one JSON object per call and the field names come straight
 * from the ObjC side; everything here is about turning that into the shape the
 * outline and the click planner read, dropping elements that cannot be aimed at.
 */

import type { AxElementInfo, AxProbe } from '@shared/types'
import { flag, mapBounds, numberOf, runHelper } from './process'

/** The native walk has its own 600 ms budget; this only covers a target that stops answering. */
const PROBE_TIMEOUT_MS = 3000

function mapAxElement(raw: unknown): AxElementInfo | null {
  if (typeof raw !== 'object' || raw === null) return null
  const source = raw as Record<string, unknown>
  const role = typeof source.role === 'string' ? source.role : ''
  if (!role) return null
  const element: AxElementInfo = {
    role,
    frame: mapBounds(source.frame),
    pressable: flag(source.pressable),
    editable: flag(source.editable)
  }
  if (typeof source.subrole === 'string') element.subrole = source.subrole
  if (typeof source.title === 'string') element.title = source.title
  if (typeof source.value === 'string') element.value = source.value
  if (typeof source.description === 'string') element.description = source.description
  if (typeof source.help === 'string') element.help = source.help
  if (typeof source.roleDescription === 'string') element.roleDescription = source.roleDescription
  const depth = numberOf(source.depth)
  if (depth !== null) element.depth = depth
  const pid = numberOf(source.pid)
  if (pid !== null) element.pid = pid
  if (Array.isArray(source.actions)) {
    element.actions = source.actions.filter((name): name is string => typeof name === 'string')
  }
  return element
}

/**
 * The element that has the keyboard, or null when Accessibility cannot say.
 *
 * Checked before typing: the plan is "click the field, then type", and a click
 * that landed next to a small field would otherwise deliver the text to whatever
 * is actually focused. One round trip, not a tree walk — the check runs on the
 * path of every keystroke.
 */
export async function helperFocused(pid: number | null): Promise<AxElementInfo | null> {
  const payload = await runHelper(['focused', String(pid !== null && pid > 0 ? Math.round(pid) : 0)])
  if (!payload?.ok) return null
  return mapAxElement(payload.focused)
}

/**
 * Asks the Accessibility API where things are.
 *
 * `point` is the model's guess: the helper reports the element under it (and its
 * ancestors) along with everything actionable in the focused window and the menu
 * bar, so the caller can tell "clicked the icon" from "clicked 20 points left of
 * the icon". Returns null when Accessibility is not granted or the helper is
 * missing, which the caller treats as "aim with the model's point".
 *
 * The native walk has its own 600 ms budget; the timeout here only covers a
 * target application that stops answering in the middle of it.
 */
export async function helperProbe(
  pid: number | null,
  point?: { x: number; y: number } | null
): Promise<AxProbe | null> {
  const args = ['probe', String(pid !== null && pid > 0 ? Math.round(pid) : 0)]
  if (point) args.push(String(Math.round(point.x)), String(Math.round(point.y)))
  const payload = await runHelper(args, PROBE_TIMEOUT_MS)
  if (!payload?.ok) return null
  const probePid = numberOf(payload.pid)
  if (probePid === null) return null
  const list = (value: unknown): AxElementInfo[] =>
    Array.isArray(value)
      ? value
          .map(mapAxElement)
          .filter((element): element is AxElementInfo => element !== null && element.frame != null)
      : []
  return {
    pid: probePid,
    app: typeof payload.app === 'string' ? payload.app : '',
    chain: list(payload.chain),
    targets: list(payload.targets),
    focused: mapAxElement(payload.focused),
    elapsedMs: numberOf(payload.elapsedMs) ?? 0
  }
}
