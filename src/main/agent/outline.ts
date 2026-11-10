/**
 * A short, copyable list of what is on screen and clickable.
 *
 * The model sees a downscaled screenshot and writes coordinates by eye. On a
 * dense list that is twenty to sixty points of error — one row up or down — and
 * a click on the row next door is a different pane, a different tab, a different
 * setting. The names come from the Accessibility API and are exact, so the same
 * model that cannot hit a row can still copy a line:
 *
 *     0.660 0.268  кнопка «Темное»
 *
 * and the point stops being a guess and becomes a handle for the name. The
 * targeting rules already snap to the element whose name the model wrote; this
 * module exists so the model writes the *real* name instead of a paraphrase.
 *
 * The list is deliberately small: only named, pressable elements inside the
 * window the request is about, in reading order, capped. A long list costs a
 * second screenshot in tokens and makes the model worse, not better.
 */

import type { AxElementInfo, AxProbe, ScreenRect } from '@shared/types'
import { helperProbe } from '../native/helper'

/**
 * The texts that can name an element.
 *
 * `AXValue` is either text or the state of a toggle, and only the first can name
 * a target: a checkbox whose value is "1" is not called "1". A generic role name
 * may help matching but must never contradict a real name, so it is not in this
 * list — it is only consulted as a last resort by the caller.
 */
function nameTexts(element: AxElementInfo): string[] {
  const value = element.value?.trim()
  const stateValue =
    /^(?:AXButton|AXToolbarButton|AXCheckBox|AXRadioButton|AXSlider|AXSwitch)$/.test(element.role) &&
    /^(?:[+-]?\d+(?:[.,]\d+)?|true|false)$/i.test(value ?? '')
  const textValue = element.editable || stateValue ? null : value
  return [element.title, element.description, element.help, textValue].filter(
    (text): text is string => Boolean(text?.trim())
  )
}

const MAX_ITEMS = 70
const MAX_NAME = 46
/**
 * How many candidates to collect before sorting.
 *
 * The list is capped after it is put into reading order, so the cap has to be
 * applied to a larger set: otherwise the last row of the window could be dropped
 * while an element from the first row was kept.
 */
const OVERCOLLECT_FACTOR = 3
/** Elements whose vertical centres are this close are on the same row. */
const SAME_ROW_POINTS = 12
/** A frame smaller than this on either side is a hairline or a collapsed row. */
const MIN_FRAME_SIDE = 2

/**
 * The Accessibility API's word for a widget, shortened for the list.
 *
 * Generic names ("кнопка", "строка") are dropped from a different field — a
 * `roleDescription` is the kind of control, never what the user reads on it, so
 * it must not be mistaken for a name here.
 */
const ROLE_WORD: Record<string, string> = {
  AXButton: 'кнопка',
  AXMenuItem: 'пункт меню',
  AXMenuButton: 'меню',
  AXPopUpButton: 'список',
  AXCheckBox: 'флажок',
  AXRadioButton: 'переключатель',
  AXTextField: 'поле',
  AXTextArea: 'поле',
  AXSearchField: 'поле поиска',
  AXRow: 'строка',
  AXCell: 'ячейка',
  AXLink: 'ссылка',
  AXTab: 'вкладка',
  AXSlider: 'ползунок',
  AXComboBox: 'поле'
}

/**
 * Roles the system treats as a place to type.
 *
 * Mirrors `axRoleIsField` in `src/main/native/helper.m`, which is what sets
 * `editable` on the wire. The outline used to keep only the first two, so a
 * search field and a combo box — both editable, both named in `ROLE_WORD` below
 * — were never listed: the model could not address them by name and had to
 * measure them by eye, which is exactly what this list exists to avoid.
 */
const TYPING_ROLES = new Set(['AXTextField', 'AXTextArea', 'AXSearchField', 'AXComboBox'])

function visibleName(element: AxElementInfo): string {
  const text = (nameTexts(element)[0] ?? '').replace(/\s+/g, ' ').trim()
  return text.length > MAX_NAME ? `${text.slice(0, MAX_NAME - 1)}…` : text
}

/** A 0..1 fraction of the screen, at the three decimals the model copies. */
function formatFraction(value: number): string {
  return value.toFixed(3)
}

function inside(frame: ScreenRect, area: ScreenRect): boolean {
  const cx = frame.x + frame.width / 2
  const cy = frame.y + frame.height / 2
  return cx >= area.x && cx <= area.x + area.width && cy >= area.y && cy <= area.y + area.height
}

/**
 * Whether an element is a usable target at all: a real frame of at least 2×2,
 * with its centre inside the capture the model saw and inside the window the
 * request is about.
 *
 * The two callers start here and then diverge, and the difference is kept rather
 * than unified: `formatOutline` also requires a visible name and lists an
 * editable only when the role is one a person can type into, while the grounding
 * set keeps every editable — a checkbox carries a name the model may quote even
 * though it is not a place to type.
 */
function isListable(
  element: AxElementInfo,
  captureArea: ScreenRect,
  windowBounds: ScreenRect | null
): element is AxElementInfo & { frame: ScreenRect } {
  const rect = element.frame
  if (!rect || rect.width < MIN_FRAME_SIDE || rect.height < MIN_FRAME_SIDE) return false
  if (!inside(rect, captureArea)) return false
  if (!inside(rect, windowBounds ?? captureArea)) return false
  return Boolean(element.pressable || element.editable)
}

/**
 * One line per named control, in the order the eye reads them.
 *
 * Elements outside `windowBounds` — a virtualised list reports rows that are
 * scrolled out of the window — are dropped: the model cannot have seen them, and
 * naming one would aim a click below the window's edge.
 */
export function formatOutline(
  probe: AxProbe,
  windowBounds: ScreenRect | null,
  captureArea: ScreenRect
): string | null {
  const seen = new Set<string>()
  const rows: { x: number; y: number; line: string }[] = []

  for (const element of probe.targets) {
    if (!isListable(element, captureArea, windowBounds)) continue
    const rect = element.frame
    if (element.editable && !TYPING_ROLES.has(element.role)) continue
    const name = visibleName(element)
    if (!name) continue
    const kind = ROLE_WORD[element.role] ?? ''
    const key = `${name}|${Math.round(rect.x)},${Math.round(rect.y)}`
    if (seen.has(key)) continue
    seen.add(key)
    const cx = (rect.x + rect.width / 2 - captureArea.x) / captureArea.width
    const cy = (rect.y + rect.height / 2 - captureArea.y) / captureArea.height
    const line = `  ${formatFraction(cx)} ${formatFraction(cy)}  ${kind ? `${kind} ` : ''}«${name}»`
    rows.push({ x: rect.x, y: rect.y, line })
    if (rows.length >= MAX_ITEMS * OVERCOLLECT_FACTOR) break
  }

  if (rows.length === 0) return null
  rows.sort((a, b) =>
    Math.abs(a.y - b.y) > SAME_ROW_POINTS ? a.y - b.y : a.x - b.x
  )
  const kept = rows.slice(0, MAX_ITEMS)

  return [
    '[Элементы активного окна]',
    'То, что сейчас можно нажать, с точными названиями. Если нужный пункт есть',
    'здесь — бери координаты из его строки, а название копируй в «…» как есть:',
    '  @click X Y left «Название»',
    'Это точнее, чем мерить по картинке: имя важнее координат, по нему клик',
    'ставится в центр элемента.',
    'Для рисунка используй @point circle X Y «Название» с тем же точным названием:',
    'приложение привяжет обводку к границам однозначно названного элемента.',
    '',
    ...kept.map((row) => row.line),
    ...(rows.length > kept.length ? [`  …и ещё ${rows.length - kept.length}`] : [])
  ].join('\n')
}

/**
 * Probes the app the request is about and renders the list, or null when the
 * Accessibility API has nothing to say (a canvas app, no permission).
 */
export async function describeScreen(
  pid: number | null,
  windowBounds: ScreenRect | null,
  captureArea: ScreenRect,
  onDrawingTargets?: (targets: AxElementInfo[]) => void
): Promise<string | null> {
  const probe = await helperProbe(pid)
  if (!probe || probe.targets.length === 0) return null
  onDrawingTargets?.(probe.targets
    .filter((element) => isListable(element, captureArea, windowBounds))
    .map((element) => ({ ...element, pid: element.pid ?? probe.pid })))
  return formatOutline(probe, windowBounds, captureArea)
}
