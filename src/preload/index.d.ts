import type { HushApi } from '../shared/types'

declare global {
  interface Window {
    hush: HushApi
  }
}
