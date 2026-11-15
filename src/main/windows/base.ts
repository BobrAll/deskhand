import { preloadPath } from '../preloadPath'

/** The app's own window colour, so the first frame is not white. */
const WINDOW_BACKGROUND = '#0f1115'
/** Where the traffic lights sit inside the hidden-inset title bar. */
const TRAFFIC_LIGHT_POSITION = { x: 16, y: 18 }

/** The BrowserWindow options every standalone app window starts from. */
export function appWindowOptions(
  title: string,
  width: number,
  height: number
): Electron.BrowserWindowConstructorOptions {
  return {
    width,
    height,
    show: false,
    title,
    backgroundColor: WINDOW_BACKGROUND,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: TRAFFIC_LIGHT_POSITION,
    webPreferences: {
      preload: preloadPath,
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  }
}
