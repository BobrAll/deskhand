/**
 * The application menu.
 *
 * The tray offers the same Settings and Quit entries, so their labels come from
 * `menus.ts` instead of being spelled out twice.
 *
 * The Window submenu is not decoration: the settings window holds ⌘W open until
 * an in-flight write lands, and that grace period is only reachable if the menu
 * actually sends ⌘W to the window. Without a `close` role the key does nothing,
 * and the shortcut the window code documents leads nowhere.
 */

import { app, Menu } from 'electron'
import type { MenuItemConstructorOptions } from 'electron'
import { QUIT_LABEL, SETTINGS_ACCELERATOR, SETTINGS_LABEL } from '../menus'
import { openSettingsWindow } from './settings'

export function applicationMenuTemplate(): MenuItemConstructorOptions[] {
  return [
    {
      label: app.name,
      submenu: [
        { role: 'about', label: 'О Deskhand' },
        { type: 'separator' },
        { label: SETTINGS_LABEL, accelerator: SETTINGS_ACCELERATOR, click: () => openSettingsWindow() },
        { type: 'separator' },
        { role: 'hide', label: 'Скрыть' },
        { role: 'hideOthers', label: 'Скрыть остальные' },
        { type: 'separator' },
        { role: 'quit', label: QUIT_LABEL }
      ]
    },
    {
      label: 'Правка',
      submenu: [
        { role: 'undo', label: 'Отменить' },
        { role: 'redo', label: 'Повторить' },
        { type: 'separator' },
        { role: 'cut', label: 'Вырезать' },
        { role: 'copy', label: 'Копировать' },
        { role: 'paste', label: 'Вставить' },
        { role: 'selectAll', label: 'Выделить всё' }
      ]
    },
    {
      label: 'Окно',
      submenu: [
        { role: 'close', label: 'Закрыть окно', accelerator: 'CommandOrControl+W' },
        { role: 'minimize', label: 'Свернуть', accelerator: 'CommandOrControl+M' },
        { role: 'zoom', label: 'Развернуть' },
        { type: 'separator' },
        { role: 'front', label: 'Все окна на передний план' }
      ]
    }
  ]
}

export function buildApplicationMenu(): void {
  Menu.setApplicationMenu(Menu.buildFromTemplate(applicationMenuTemplate()))
}
