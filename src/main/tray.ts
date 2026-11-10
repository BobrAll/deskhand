/**
 * The tray icon: the only persistent surface of the app (no Dock icon, ТЗ §12).
 */

import { Menu, Tray, app, nativeImage, shell } from 'electron'
import { prettyAccelerator } from '@shared/accelerator'
import { resourcePath } from './paths'
import { getSettings } from './settings/store'

export interface TrayActions {
  toggle(): void
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
    { label: `Открыть ассистента (${hotkey})`, click: () => actions?.toggle() },
    { type: 'separator' },
    { label: 'Настройки…', accelerator: 'CommandOrControl+,', click: () => actions?.openSettings() },
    { label: 'Права доступа и первый запуск…', click: () => actions?.openOnboarding() },
    { type: 'separator' },
    {
      label: 'Папка данных',
      click: () => {
        void shell.openPath(app.getPath('userData'))
      }
    },
    { type: 'separator' },
    { label: 'Выйти из Deskhand', accelerator: 'CommandOrControl+Q', click: () => actions?.quit() }
  ])
}

export function createTray(trayActions: TrayActions): Tray {
  actions = trayActions
  if (tray) return tray
  tray = new Tray(trayImage())
  tray.setToolTip('Deskhand')
  tray.setContextMenu(buildMenu())
  tray.on('click', () => actions?.toggle())
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