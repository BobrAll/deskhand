import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

/**
 * Test runner for the pure logic of `src/`.
 *
 * Nothing here touches Electron, the real electron-store, Keychain or the
 * network: suites mock those explicitly.
 */
export default defineConfig({
  resolve: {
    alias: { '@shared': resolve(__dirname, 'src/shared') }
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts']
    }
  }
})
