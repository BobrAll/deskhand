/**
 * The tray icon: the persistent entry point to the card, the settings and the
 * data folder (ТЗ §12). The app also has a Dock icon and a Cmd+Tab entry; the
 * tray is what stays reachable when no window is open.
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
let actions: TrayActions | null = null

function trayImage(): Electron.NativeImage {
  const image = nativeImage.createFromPath(resourcePath('trayTemplate.png'))
  if (image.isEmpty()) return nativeImage.createEmpty()
  image.setTemplateImage(true)
  return image
}

function buildMenu(): Menu {
  const hotkey = prettyAccelerator(getSettings().hotkey)
  return Menu.buildFromTemplate([
    { label: openAssistantLabel(hotkey), click: () => actions?.openAssistant() },
    { type: 'separator' },
    { label: SETTINGS_LABEL, accelerator: SETTINGS_ACCELERATOR, click: () => actions?.openSettings() },
    { label: 'Права доступа и первый запуск…', click: () => actions?.openOnboarding() },
    { type: 'separator' },
    {
      label: 'Папка данных',
      click: () => {
        void shell.openPath(app.getPath('userData'))
      }
    },
    { type: 'separator' },
    { label: QUIT_LABEL, accelerator: QUIT_ACCELERATOR, click: () => actions?.quit() }
  ])
}

export function createTray(trayActions: TrayActions): Tray {
  actions = trayActions
  if (tray) return tray
  tray = new Tray(trayImage())
  tray.setToolTip('Deskhand')
  tray.setContextMenu(buildMenu())
  tray.on('click', () => actions?.openAssistant())
  return tray
}

/** Rebuilds the menu so the hotkey hint stays accurate. */
export function refreshTray(): void {
  if (tray) tray.setContextMenu(buildMenu())
}

export function destroyTray(): void {
  tray?.destroy()
  tray = null
  actions = null
}
