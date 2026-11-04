import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

const shared = resolve(__dirname, 'src/shared')

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { '@shared': shared } },
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/main/index.ts') }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { '@shared': shared } },
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts') }
      }
    }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    resolve: { alias: { '@shared': shared } },
    plugins: [react()],
    build: {
      rollupOptions: {
        input: {
          overlay: resolve(__dirname, 'src/renderer/overlay/index.html'),
          pointer: resolve(__dirname, 'src/renderer/pointer/index.html'),
          cursor: resolve(__dirname, 'src/renderer/cursor/index.html'),
          hud: resolve(__dirname, 'src/renderer/hud/index.html'),
          settings: resolve(__dirname, 'src/renderer/settings/index.html'),
          onboarding: resolve(__dirname, 'src/renderer/onboarding/index.html')
        }
      }
    }
  }
})