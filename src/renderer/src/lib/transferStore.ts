import { useCallback, useSyncExternalStore } from 'react'
import type { ImageTransfer } from '../../../shared/types'

// File transfer progress lives outside React state, so each update re-renders only the bubble
// showing that file, not the whole app.
const transfers = new Map<string, ImageTransfer>()
const listeners = new Map<string, Set<() => void>>()

export function setTransfer(t: ImageTransfer): void {
  transfers.set(t.id, t)
  listeners.get(t.id)?.forEach((notify) => notify())
}

export function getTransfer(id: string): ImageTransfer | undefined {
  return transfers.get(id)
}

export function subscribeTransfer(id: string, notify: () => void): () => void {
  const set = listeners.get(id) ?? new Set()
  listeners.set(id, set.add(notify))
  return () => {
    set.delete(notify)
    if (set.size === 0) listeners.delete(id)
  }
}

export function useTransfer(id: string): ImageTransfer | undefined {
  const subscribe = useCallback((notify: () => void) => subscribeTransfer(id, notify), [id])
  return useSyncExternalStore(subscribe, () => getTransfer(id))
}
