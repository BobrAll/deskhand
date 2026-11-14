/**
 * Mapping the helper's Accessibility answers into `AxElementInfo`.
 *
 * The helper prints one JSON object per call and the field names come straight
 * from the ObjC side; everything here is about turning that into the shape the
 * outline reads, dropping elements that cannot be aimed at.
 */

import type { AxElementInfo, AxProbe } from '@shared/types'
import { flag, mapBounds, numberOf, runHelper } from './process'

/** The native walk has its own 600 ms budget; this only covers a target that stops answering. */
const PROBE_TIMEOUT_MS = 3000
/** A focused-element read is one round trip; a slow app must not delay the bars. */
const FOCUSED_TIMEOUT_MS = 1500

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
 * Asks the Accessibility API where things are.
 *
 * Returns the flat list of everything actionable in the focused window and the
 * menu bar, or null when Accessibility is not granted or the helper is missing,
 * which the caller treats as "no outline to offer".
 *
 * The native walk has its own 600 ms budget; the timeout here only covers a
 * target application that stops answering in the middle of it.
 */
export async function helperProbe(pid: number | null): Promise<AxProbe | null> {
  const payload = await runHelper(
    ['probe', String(pid !== null && pid > 0 ? Math.round(pid) : 0)],
    PROBE_TIMEOUT_MS
  )
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
    targets: list(payload.targets),
    elapsedMs: numberOf(payload.elapsedMs) ?? 0
  }
}

/**
 * The element that has the keyboard in `pid`, without walking the whole tree.
 *
 * Dictation uses this to place a border around the field it is about to type
 * into. `editable` is the signal that the frame is a text field and not a
 * focused button or a whole web view; a caller that gets a non-editable element
 * should not draw anything.
 */
export async function helperFocused(pid: number): Promise<AxElementInfo | null> {
  const payload = await runHelper(['focused', String(Math.round(pid))], FOCUSED_TIMEOUT_MS)
  if (!payload?.ok) return null
  return mapAxElement(payload.focused)
}
