import type { SmartCursorApi } from '@shared/api'

declare global {
  interface Window {
    smartCursor: SmartCursorApi
  }
}

export {}