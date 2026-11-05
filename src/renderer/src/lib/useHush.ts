import { useCallback, useEffect, useRef, useState } from 'react'
import type { CallRecord, ChatMessage, HushEvent, ImageTransfer, OutgoingImage, Settings, Snapshot } from '../../../shared/types'
import type { DeliveryNotice } from './timeline'

const PAGE = 100
/** Hide the typing indicator if no refresh arrives within this time. */
const TYPING_TTL_MS = 6000

export interface HushState {
  snapshot: Snapshot | null
  messages: ChatMessage[]
  hasMore: boolean
  loadingOlder: boolean
  peerTyping: boolean
  /** Call history, oldest first. */
  calls: CallRecord[]
  /** Session-only "N queued messages delivered" lines. */
  notices: DeliveryNotice[]
  /** The most recent flush, for the pop-up; null once it has been dismissed. */
  flush: DeliveryNotice | null
  dismissFlush: () => void
  /** Image transfers in progress / finished / failed, by message id. */
  transfers: Record<string, ImageTransfer>
  sendImage: (image: OutgoingImage, caption: string) => Promise<void>
  retryImage: (id: string) => void
  loadOlder: () => void
  send: (text: string) => Promise<void>
  markRead: (ids: string[]) => void
  updateSettings: (patch: Partial<Settings>) => Promise<void>
}

/** Renderer-side state, kept in sync with the main process through window.hush events. */
export function useHush(): HushState {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [hasMore, setHasMore] = useState(false)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [peerTyping, setPeerTyping] = useState(false)
  const [notices, setNotices] = useState<DeliveryNotice[]>([])
  const [flush, setFlush] = useState<DeliveryNotice | null>(null)
  const [transfers, setTransfers] = useState<Record<string, ImageTransfer>>({})
  const [calls, setCalls] = useState<CallRecord[]>([])
  const typingTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const loading = useRef(false)
  const hasMoreRef = useRef(false)
  hasMoreRef.current = hasMore

  useEffect(() => {
    let alive = true
    const api = window.hush

    const onEvent = (e: HushEvent): void => {
      switch (e.type) {
        case 'message':
          setMessages((prev) => insertSorted(prev, e.message, hasMoreRef.current))
          break
        case 'pairing':
          setSnapshot((s) => s && { ...s, pairing: e.pairing })
          break
        case 'privacy':
          setSnapshot((s) => s && { ...s, privacy: e.privacy })
          break
        case 'window':
          setSnapshot((s) => s && { ...s, windowActive: e.active })
          break
        case 'avatars':
          setSnapshot((s) => s && { ...s, avatars: e.avatars })
          break
        case 'call-log':
          setCalls((prev) => [...prev.filter((c) => c.id !== e.record.id), e.record].sort((a, b) => a.startedAt - b.startedAt))
          break
        case 'transfer': {
          const t = e.transfer
          setTransfers((prev) => ({ ...prev, [t.id]: t }))
          if (t.direction === 'down' && t.state === 'done') {
            setMessages((prev) => prev.map((m) => (m.id === t.id && m.image ? { ...m, image: { ...m.image, ready: true } } : m)))
          }
          break
        }
        case 'flushed': {
          const notice = { id: `${e.at}`, at: e.at, count: e.count }
          setNotices((prev) => [...prev, notice])
          setFlush(notice)
          break
        }
        case 'status': {
          const next = new Map(e.updates.map((u) => [u.id, u.status]))
          setMessages((prev) => prev.map((m) => (next.has(m.id) ? { ...m, status: next.get(m.id)! } : m)))
          break
        }
        case 'typing':
          clearTimeout(typingTimer.current)
          setPeerTyping(e.on)
          if (e.on) typingTimer.current = setTimeout(() => setPeerTyping(false), TYPING_TTL_MS)
          break
        case 'peer':
          setSnapshot((s) => s && { ...s, peer: e.peer })
          if (e.peer.presence === 'offline') setPeerTyping(false)
          break
        case 'net':
          setSnapshot((s) => s && { ...s, net: e.net })
          break
        case 'settings':
          setSnapshot((s) => s && { ...s, settings: e.settings })
          break
      }
    }

    // Subscribe first so nothing is missed between the snapshot and the first page.
    const off = api.onEvent(onEvent)
    void Promise.all([api.getSnapshot(), api.listMessages(undefined, PAGE), api.listCalls()]).then(([snap, page, history]) => {
      if (!alive) return
      setSnapshot(snap)
      setCalls((live) => [...history.filter((h) => !live.some((c) => c.id === h.id)), ...live].sort((a, b) => a.startedAt - b.startedAt))
      setMessages((live) => {
        const ids = new Set(page.messages.map((m) => m.id))
        return [...page.messages, ...live.filter((m) => !ids.has(m.id))]
      })
      setHasMore(page.hasMore)
    })
    return () => {
      alive = false
      off()
      clearTimeout(typingTimer.current)
    }
  }, [])

  const loadOlder = useCallback(() => {
    if (loading.current || !hasMore || messages.length === 0) return
    loading.current = true
    setLoadingOlder(true)
    const oldest = messages[0]
    void window.hush
      .listMessages({ sentAt: oldest.sentAt, id: oldest.id }, PAGE)
      .then((page) => {
        setMessages((prev) => {
          const ids = new Set(prev.map((m) => m.id))
          return [...page.messages.filter((m) => !ids.has(m.id)), ...prev]
        })
        setHasMore(page.hasMore)
      })
      .finally(() => {
        loading.current = false
        setLoadingOlder(false)
      })
  }, [hasMore, messages])

  const send = useCallback(async (text: string) => {
    // The main process echoes the new message back as a 'message' event.
    await window.hush.sendMessage(text)
  }, [])

  const markRead = useCallback((ids: string[]) => {
    if (ids.length === 0) return
    const set = new Set(ids)
    setMessages((prev) => prev.map((m) => (set.has(m.id) ? { ...m, status: 'read' } : m)))
    window.hush.markRead(ids)
  }, [])

  const updateSettings = useCallback(async (patch: Partial<Settings>) => {
    const settings = await window.hush.updateSettings(patch)
    setSnapshot((s) => s && { ...s, settings })
  }, [])

  const dismissFlush = useCallback(() => setFlush(null), [])

  const sendImage = useCallback(async (image: OutgoingImage, caption: string) => {
    await window.hush.sendImage(image, caption)
  }, [])

  const retryImage = useCallback((id: string) => {
    setTransfers((prev) => ({ ...prev, [id]: { id, direction: 'down', state: 'active', progress: 0 } }))
    window.hush.retryImage(id)
  }, [])

  return {
    snapshot,
    messages,
    hasMore,
    loadingOlder,
    peerTyping,
    calls,
    notices,
    flush,
    dismissFlush,
    transfers,
    sendImage,
    retryImage,
    loadOlder,
    send,
    markRead,
    updateSettings
  }
}

/**
 * Adds a message keeping time order — synced messages can be older than ones already shown.
 * If it is older than the loaded window while more history remains unloaded, it is skipped
 * (inserting it would move the paging cursor past the unloaded messages); paging loads it.
 */
export function insertSorted(list: ChatMessage[], m: ChatMessage, moreHistory: boolean): ChatMessage[] {
  if (list.some((x) => x.id === m.id)) return list
  const after = (x: ChatMessage): boolean => x.sentAt > m.sentAt || (x.sentAt === m.sentAt && x.id > m.id)
  if (list.length === 0 || !after(list[list.length - 1])) return [...list, m]
  if (after(list[0])) return moreHistory ? list : [m, ...list]
  const i = list.findIndex(after)
  return [...list.slice(0, i), m, ...list.slice(i)]
}
