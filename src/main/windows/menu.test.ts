import { describe, expect, it, vi } from 'vitest'

import type { MenuItemConstructorOptions } from 'electron'

/**
 * The application menu is the only route to ⌘W for the settings window, and the
 * window's close grace period depends on that key actually reaching it. The
 * template is checked instead of a built menu: Electron is a fake here.
 */

const menu = vi.hoisted(() => ({
  templates: [] as MenuItemConstructorOptions[][],
  installed: null as unknown
}))

vi.mock('electron', () => ({
  app: { name: 'Deskhand' },
  Menu: {
    buildFromTemplate: (template: MenuItemConstructorOptions[]) => {
      menu.templates.push(template)
      return { template }
    },
    setApplicationMenu: (built: unknown) => {
      menu.installed = built
    }
  }
}))
vi.mock('./settings', () => ({ openSettingsWindow: vi.fn() }))

const { applicationMenuTemplate, buildApplicationMenu } = await import('./menu')

function submenuOf(label: string): MenuItemConstructorOptions[] {
  const item = applicationMenuTemplate().find((entry) => entry.label === label)
  if (!item) throw new Error(`no «${label}» menu`)
  return item.submenu as MenuItemConstructorOptions[]
}

describe('application menu', () => {
  it('gives the window menu a close role with ⌘W', () => {
    const close = submenuOf('Окно').find((entry) => entry.role === 'close')

    expect(close).toMatchObject({ role: 'close', label: 'Закрыть окно' })
    expect(close?.accelerator).toBe('CommandOrControl+W')
  })

  it('keeps the standard zoom and minimize roles next to it', () => {
    const roles = submenuOf('Окно')

    expect(roles.find((entry) => entry.role === 'minimize')).toMatchObject({
      label: 'Свернуть',
      accelerator: 'CommandOrControl+M'
    })
    expect(roles.find((entry) => entry.role === 'zoom')).toMatchObject({ label: 'Развернуть' })
    expect(roles.find((entry) => entry.role === 'front')).toMatchObject({
      label: 'Все окна на передний план'
    })
  })

  it('still offers settings and quit in the app menu', () => {
    const appMenu = submenuOf('Deskhand')

    expect(appMenu.find((entry) => entry.label === 'Настройки…')).toMatchObject({
      accelerator: 'CommandOrControl+,'
    })
    expect(appMenu.find((entry) => entry.role === 'quit')).toMatchObject({
      label: 'Выйти из Deskhand'
    })
  })

  it('installs the built menu', () => {
    buildApplicationMenu()

    expect(menu.templates).toHaveLength(1)
    expect(menu.installed).toEqual({ template: menu.templates[0] })
  })
})
