/**
 * The tray icon: the persistent entry point to the card, the settings and the
 * data folder (ТЗ §12). The app is a tray-only accessory — no Dock icon, no
 * Cmd+Tab entry — so the tray is what stays reachable when no window is open.
 */

import { Menu, Tray, app, nativeImage, shell } from 'electron'
import { prettyAccelerator } from '@shared/accelerator'
import { openAssistantLabel, QUIT_ACCELERATOR, QUIT_LABEL, SETTINGS_ACCELERATOR, SETTINGS_LABEL } from './menus'
import { resourcePath } from './paths'
import { getSettings } from './settings/store'

export interface TrayActions {
  openAssistant(): void
  openSettings(): void
  openOnboarding(): void
  quit(): void
}

let tray: Tray | null = null
/** What the tray menu clicks reach while the tray exists. */
let trayActions: TrayActions | null = null
/**
 * The update item, read at menu-build time.
 *
 * Injected by the app entry point instead of imported from `update/`: the
 * update controller refreshes the tray when its state moves, and a direct
 * import either way would close that loop.
 */
let trayUpdateLine: (() => { label: string; onClick: () => void } | null) | null = null

function trayImage(): Electron.NativeImage {
  const image = nativeImage.createFromPath(resourcePath('trayTemplate.png'))
  if (image.isEmpty()) return nativeImage.createEmpty()
  image.setTemplateImage(true)
  return image
}

function buildMenu(): Menu {
  const hotkey = prettyAccelerator(getSettings().hotkey)
  const update = trayUpdateLine?.()
  return Menu.buildFromTemplate([
    ...(update ? [{ label: `${update.label}…`, click: () => update.onClick() }, { type: 'separator' as const }] : []),
    { label: openAssistantLabel(hotkey), click: () => trayActions?.openAssistant() },
    { type: 'separator' },
    { label: SETTINGS_LABEL, accelerator: SETTINGS_ACCELERATOR, click: () => trayActions?.openSettings() },
    { label: 'Права доступа и первый запуск…', click: () => trayActions?.openOnboarding() },
    { type: 'separator' },
    {
      label: 'Папка данных',
      click: () => {
        void shell.openPath(app.getPath('userData'))
      }
    },
    { type: 'separator' },
    { label: QUIT_LABEL, accelerator: QUIT_ACCELERATOR, click: () => trayActions?.quit() }
  ])
}

export function createTray(actions: TrayActions): Tray {
  trayActions = actions
  if (tray) return tray
  tray = new Tray(trayImage())
  tray.setToolTip('Deskhand')
  tray.setContextMenu(buildMenu())
  tray.on('click', () => trayActions?.openAssistant())
  return tray
}

/** Rebuilds the menu so the hotkey hint stays accurate. */
export function refreshTray(): void {
  if (tray) tray.setContextMenu(buildMenu())
}

/** Points the menu at the update controller's current line (or removes it). */
export function setTrayUpdateLine(get: (() => { label: string; onClick: () => void } | null) | null): void {
  trayUpdateLine = get
  refreshTray()
}

export function destroyTray(): void {
  tray?.destroy()
  tray = null
  trayActions = null
  trayUpdateLine = null
}
