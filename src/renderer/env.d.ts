import type { DeskhandApi } from '@shared/api'

declare global {
  interface Window {
    deskhand: DeskhandApi
  }
}

export {}