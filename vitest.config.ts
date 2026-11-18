import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

/**
 * Test runner for the pure logic of `src/` and `scripts/`.
 *
 * Nothing here touches Electron, the real electron-store or the network:
 * suites mock those explicitly.
 */
export default defineConfig({
  resolve: {
    alias: { '@shared': resolve(__dirname, 'src/shared') }
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'scripts/**/*.test.mjs'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts']
    }
  }
})
