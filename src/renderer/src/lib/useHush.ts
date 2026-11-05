import { useCallback, useEffect, useRef, useState } from 'react'
import type { ChatMessage, HushEvent, Settings, Snapshot } from '../../../shared/types'

const PAGE = 100
/** Hide the typing indicator if no refresh arrives within this time. */
const TYPING_TTL_MS = 6000

export interface HushState {
  snapshot: Snapshot | null
  messages: ChatMessage[]
  hasMore: boolean
  loadingOlder: boolean
  peerTyping: boolean
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
  const typingTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const loading = useRef(false)

  useEffect(() => {
    let alive = true
    const api = window.hush

    const onEvent = (e: HushEvent): void => {
      switch (e.type) {
        case 'message':
          setMessages((prev) => (prev.some((m) => m.id === e.message.id) ? prev : [...prev, e.message]))
          break
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
    void Promise.all([api.getSnapshot(), api.listMessages(undefined, PAGE)]).then(([snap, page]) => {
      if (!alive) return
      setSnapshot(snap)
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

  return { snapshot, messages, hasMore, loadingOlder, peerTyping, loadOlder, send, markRead, updateSettings }
}
