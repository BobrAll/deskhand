/**
 * Menu strings shared by the application menu and the tray menu.
 *
 * The two menus describe the same commands, so they read the same words and
 * accelerators from here. They used to spell them out twice, and a rename could
 * reach one menu while missing the other.
 */

export const SETTINGS_LABEL = 'Настройки…'
export const SETTINGS_ACCELERATOR = 'CommandOrControl+,'

export const QUIT_LABEL = 'Выйти из Deskhand'
export const QUIT_ACCELERATOR = 'CommandOrControl+Q'

/** Tray entry for the card; the hint keeps the configured combination visible. */
export function openAssistantLabel(hotkey: string): string {
  return `Открыть ассистента (${hotkey})`
}
