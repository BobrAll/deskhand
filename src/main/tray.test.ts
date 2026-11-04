import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The tray menu is the app's only persistent surface, and it is built from the
 * current settings — so the two things worth pinning are the menu it builds and
 * the fact that every item reaches the action it names. The window objects are
 * fakes; nothing is created (docs/refactor/RULES.md).
 */

const env = vi.hoisted(() => ({
  hotkey: 'Alt+Space',
  /** The last template handed to `Menu.buildFromTemplate`. */
  template: [] as Array<Record<string, unknown>>,
  /** Items clicked by the tests, by label. */
  clicked: [] as string[],
  trayInstances: 0,
  tooltip: '',
  contextMenus: 0,
  imageEmpty: false,
  openedPaths: [] as string[],
  destroyed: 0,
  clickHandlers: [] as Array<() => void>
}))

vi.mock('electron', () => {
  class FakeTray {
    constructor() {
      env.trayInstances += 1
    }
    setToolTip(value: string): void {
      env.tooltip = value
    }
    setContextMenu(): void {
      env.contextMenus += 1
    }
    on(event: string, handler: () => void): void {
      if (event === 'click') env.clickHandlers.push(handler)
    }
    destroy(): void {
      env.destroyed += 1
    }
  }

  return {
    Tray: FakeTray,
    Menu: {
      buildFromTemplate: (template: Array<Record<string, unknown>>) => {
        env.template = template
        return { template }
      }
    },
    app: {
      getPath: () => '/Users/test/Library/Application Support/Smart Cursor',
      getAppPath: () => '/app'
    },
    shell: {
      openPath: async (path: string) => {
        env.openedPaths.push(path)
        return ''
      }
    },
    nativeImage: {
      createFromPath: () => ({
        isEmpty: () => env.imageEmpty,
        setTemplateImage: () => undefined
      }),
      createEmpty: () => ({ isEmpty: () => true })
    }
  }
})

vi.mock('./settings/store', () => ({
  getSettings: () => ({ hotkey: env.hotkey })
}))

vi.mock('./paths', () => ({
  resourcePath: (name: string) => `/resources/${name}`
}))

async function loadTray(): Promise<typeof import('./tray')> {
  vi.resetModules()
  return import('./tray')
}

function actions(): import('./tray').TrayActions {
  return {
    toggle: vi.fn(),
    openSettings: vi.fn(),
    openOnboarding: vi.fn(),
    quit: vi.fn()
  }
}

/** Finds a menu item by its label. */
function item(label: string): Record<string, unknown> | undefined {
  return env.template.find((entry) => entry.label === label)
}

beforeEach(() => {
  env.hotkey = 'Alt+Space'
  env.template = []
  env.clicked = []
  env.trayInstances = 0
  env.tooltip = ''
  env.contextMenus = 0
  env.imageEmpty = false
  env.openedPaths = []
  env.destroyed = 0
  env.clickHandlers = []
})

describe('createTray: the menu', () => {
  it('names the hotkey it is currently bound to', async () => {
    const { createTray } = await loadTray()
    createTray(actions())

    expect(item('Открыть ассистента (Alt+Space)')).toBeDefined()
  })

  it('follows a hotkey change on refresh', async () => {
    const { createTray, refreshTray } = await loadTray()
    createTray(actions())

    env.hotkey = 'Cmd+Shift+Space'
    refreshTray()

    expect(item('Открыть ассистента (Cmd+Shift+Space)')).toBeDefined()
    expect(item('Открыть ассистента (Alt+Space)')).toBeUndefined()
  })

  it('keeps the four app commands and the two separators', async () => {
    const { createTray } = await loadTray()
    createTray(actions())

    expect(env.template.filter((entry) => entry.type === 'separator')).toHaveLength(3)
    for (const label of [
      'Настройки…',
      'Права доступа и первый запуск…',
      'Папка данных',
      'Выйти из Smart Cursor'
    ]) {
      expect(item(label), label).toBeDefined()
    }
  })

  it('keeps the macOS accelerators the menu promises', async () => {
    const { createTray } = await loadTray()
    createTray(actions())

    expect(item('Настройки…')?.accelerator).toBe('CommandOrControl+,')
    expect(item('Выйти из Smart Cursor')?.accelerator).toBe('CommandOrControl+Q')
  })
})

describe('createTray: every item reaches its action', () => {
  it('wires each command to the action it names', async () => {
    const { createTray } = await loadTray()
    const handlers = actions()
    createTray(handlers)

    ;(item('Открыть ассистента (Alt+Space)')?.click as () => void)()
    ;(item('Настройки…')?.click as () => void)()
    ;(item('Права доступа и первый запуск…')?.click as () => void)()
    ;(item('Выйти из Smart Cursor')?.click as () => void)()

    expect(handlers.toggle).toHaveBeenCalledTimes(1)
    expect(handlers.openSettings).toHaveBeenCalledTimes(1)
    expect(handlers.openOnboarding).toHaveBeenCalledTimes(1)
    expect(handlers.quit).toHaveBeenCalledTimes(1)
  })

  it('opens the data folder through the shell, not through an action', async () => {
    const { createTray } = await loadTray()
    createTray(actions())

    ;(item('Папка данных')?.click as () => void)()
    await Promise.resolve()

    expect(env.openedPaths).toEqual(['/Users/test/Library/Application Support/Smart Cursor'])
  })

  it('toggles on a plain click of the tray icon', async () => {
    const { createTray } = await loadTray()
    const handlers = actions()
    createTray(handlers)

    expect(env.clickHandlers).toHaveLength(1)
    env.clickHandlers[0]()
    expect(handlers.toggle).toHaveBeenCalledTimes(1)
  })
})

describe('createTray: the icon and the lifecycle', () => {
  it('sets the tooltip and the menu once', async () => {
    const { createTray } = await loadTray()
    createTray(actions())

    expect(env.tooltip).toBe('Smart Cursor')
    expect(env.contextMenus).toBe(1)
    expect(env.trayInstances).toBe(1)
  })

  it('reuses the existing tray instead of creating a second icon', async () => {
    const { createTray } = await loadTray()
    createTray(actions())
    createTray(actions())

    expect(env.trayInstances).toBe(1)
  })

  it('rebuilds nothing when there is no tray yet', async () => {
    const { refreshTray } = await loadTray()
    refreshTray()
    expect(env.contextMenus).toBe(0)
  })

  it('destroys the icon and forgets the actions', async () => {
    const { createTray, destroyTray } = await loadTray()
    const handlers = actions()
    createTray(handlers)

    destroyTray()
    expect(env.destroyed).toBe(1)

    // A click after destroy must not reach the old actions: the handler closes
    // over the module state, which `destroyTray` clears.
    env.clickHandlers[0]()
    expect(handlers.toggle).not.toHaveBeenCalled()
  })

  it('still builds a menu when the icon image is missing', async () => {
    env.imageEmpty = true
    const { createTray } = await loadTray()
    createTray(actions())
    expect(env.template.length).toBeGreaterThan(0)
  })
})
