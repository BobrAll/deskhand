import { join } from 'node:path'

const preload = join(__dirname, '../preload/index.js')

export function baseOptions(
  title: string,
  width: number,
  height: number
): Electron.BrowserWindowConstructorOptions {
  return {
    width,
    height,
    show: false,
    title,
    backgroundColor: '#0f1115',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 18 },
    webPreferences: {
      preload,
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  }
}

