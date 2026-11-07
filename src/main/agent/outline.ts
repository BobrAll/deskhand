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
import { nameTexts } from './targeting'

const MAX_ITEMS = 70
const MAX_NAME = 46

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

function visibleName(element: AxElementInfo): string {
  const text = (nameTexts(element)[0] ?? '').replace(/\s+/g, ' ').trim()
  return text.length > MAX_NAME ? `${text.slice(0, MAX_NAME - 1)}…` : text
}

function round3(value: number): string {
  return value.toFixed(3)
}

function inside(frame: ScreenRect, area: ScreenRect): boolean {
  const cx = frame.x + frame.width / 2
  const cy = frame.y + frame.height / 2
  return cx >= area.x && cx <= area.x + area.width && cy >= area.y && cy <= area.y + area.height
}

/**
 * One line per named control, in the order the eye reads them.
 *
 * Elements outside `bounds` — a virtualised list reports rows that are scrolled
 * out of the window — are dropped: the model cannot have seen them, and naming
 * one would aim a click below the window's edge.
 */
export function formatOutline(
  probe: AxProbe,
  bounds: ScreenRect | null,
  area: ScreenRect
): string | null {
  const limit = bounds ?? area
  const seen = new Set<string>()
  const rows: { x: number; y: number; line: string }[] = []

  for (const element of probe.targets) {
    const rect = element.frame
    if (!rect) continue
    if (!element.pressable && !element.editable) continue
    if (rect.width < 2 || rect.height < 2) continue
    if (!inside(rect, area)) continue
    if (!inside(rect, limit)) continue
    if (element.editable && element.role !== 'AXTextField' && element.role !== 'AXTextArea') {
      continue
    }
    const name = visibleName(element)
    if (!name) continue
    const kind = ROLE_WORD[element.role ?? ''] ?? ''
    const key = `${name}|${Math.round(rect.x)},${Math.round(rect.y)}`
    if (seen.has(key)) continue
    seen.add(key)
    const cx = (rect.x + rect.width / 2 - area.x) / area.width
    const cy = (rect.y + rect.height / 2 - area.y) / area.height
    const line = `  ${round3(cx)} ${round3(cy)}  ${kind ? `${kind} ` : ''}«${name}»`
    rows.push({ x: rect.x, y: rect.y, line })
    if (rows.length >= MAX_ITEMS * 3) break
  }

  if (rows.length === 0) return null
  rows.sort((a, b) => (Math.abs(a.y - b.y) > 12 ? a.y - b.y : a.x - b.x))
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
  bounds: ScreenRect | null,
  area: ScreenRect,
  onTargets?: (targets: AxElementInfo[]) => void
): Promise<string | null> {
  const probe = await helperProbe(pid, null)
  if (!probe || probe.targets.length === 0) return null
  onTargets?.(probe.targets.filter((element) => {
    const rect = element.frame
    return Boolean(rect && rect.width >= 2 && rect.height >= 2 &&
      inside(rect, area) && inside(rect, bounds ?? area) &&
      (element.pressable || element.editable))
  }).map((element) => ({ ...element, pid: element.pid ?? probe.pid })))
  return formatOutline(probe, bounds, area)
}
