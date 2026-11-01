import type { AppApi } from '../shared/ipc.ts'

declare global {
  interface Window {
    /** Exposed by src/preload/index.ts. */
    app: AppApi
  }
}

export {}
