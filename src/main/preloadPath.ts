/**
 * Where the compiled preload bridge lives.
 *
 * Every window loads the same bridge, so the path is written once. It used to be
 * recomputed by each window-creating module (`windows/index.ts`, `windows/base.ts`
 * and `layerWindow.ts`) with the same `join(__dirname, '../preload/index.js')` —
 * the kind of copy that keeps working until one of them is moved.
 */

import { join } from 'node:path'

/** The preload bridge every window loads, relative to the bundled main process. */
export const preloadPath = join(__dirname, '../preload/index.js')
