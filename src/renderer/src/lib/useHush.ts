import { useCallback, useEffect, useRef, useState } from 'react'
import { GENERAL_CHANNEL } from '../../../shared/protocol'
import type { CallRecord, ChatMessage, HushEvent, OutgoingImage, Settings, Snapshot } from '../../../shared/types'
import { PageGuard } from './pageGuard'
import type { DeliveryNotice } from './timeline'
import { setTransfer } from './transferStore'

const PAGE = 100
/** Hide the typing indicator if no refresh arrives within this time. */
const TYPING_TTL_MS = 6000

export interface HushState {
  snapshot: Snapshot | null
  /** The channel on screen. Hush opens on General each launch. */
  channel: string
  /**
   * Shows that channel once its newest page, and history back to `until` if given, has loaded.
   * False if another switch overtook it.
   */
  switchChannel: (id: string, until?: { id: string; sentAt: number }) => Promise<boolean>
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
  sendImage: (image: OutgoingImage, caption: string, replyTo: string | undefined, channel: string) => Promise<void>
  retryImage: (id: string) => void
  loadOlder: () => void
  /** Loads older history until this message is in the list (for search). False if not found. */
  reveal: (id: string, sentAt: number) => Promise<boolean>
  send: (text: string, replyTo: string | undefined, channel: string) => Promise<void>
  markRead: (ids: string[]) => void
  updateSettings: (patch: Partial<Settings>) => Promise<void>
}

/** Renderer-side state, kept in sync with the main process through window.hush events. */
export function useHush(): HushState {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [channel, setChannel] = useState<string>(GENERAL_CHANNEL)
  const channelRef = useRef<string>(GENERAL_CHANNEL)
  const guard = useRef(new PageGuard()).current
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [hasMore, setHasMore] = useState(false)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [peerTyping, setPeerTyping] = useState(false)
  const [notices, setNotices] = useState<DeliveryNotice[]>([])
  const [flush, setFlush] = useState<DeliveryNotice | null>(null)
  const [calls, setCalls] = useState<CallRecord[]>([])
  const typingTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const loading = useRef(false)
  const hasMoreRef = useRef(false)
  hasMoreRef.current = hasMore
  const messagesRef = useRef<ChatMessage[]>([])
  messagesRef.current = messages

  useEffect(() => {
    let alive = true
    const api = window.hush

    const onEvent = (e: HushEvent): void => {
      switch (e.type) {
        case 'message':
          // No need to hold on to messages for a channel being opened: main stores a message
          // before announcing it, so it's either in that page or arrives after the page does.
          if ((e.message.channel ?? GENERAL_CHANNEL) === channelRef.current) setMessages((prev) => insertSorted(prev, e.message, hasMoreRef.current))
          break
        case 'channels':
          setSnapshot((s) => s && { ...s, channels: e.channels })
          if (!e.channels.some((c) => c.id === channelRef.current)) void switchChannel(GENERAL_CHANNEL)
          break
        case 'unread':
          setSnapshot((s) => s && { ...s, unread: e.byChannel })
          break
        case 'open-channel':
          void switchChannel(e.channel)
          break
        case 'event': {
          // An edit, deletion or reaction: re-read that message and any loaded replies quoting it.
          const ids = [e.target, ...messagesRef.current.filter((m) => m.replyTo?.id === e.target).map((m) => m.id)]
          void api.getMessages(ids).then((fresh) => {
            if (!alive) return
            const byId = new Map(fresh.map((m) => [m.id, m]))
            setMessages((prev) =>
              prev.flatMap((m) => (byId.has(m.id) ? [byId.get(m.id)!] : ids.includes(m.id) ? [] : [m])) // missing = deleted for me
            )
          })
          break
        }
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
          setTransfer(t)
          if (t.direction === 'down' && t.state === 'done') {
            setMessages((prev) =>
              prev.map((m) =>
                m.id !== t.id ? m : m.image ? { ...m, image: { ...m.image, ready: true } } : m.file ? { ...m, file: { ...m.file, ready: true } } : m
              )
            )
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
          if ((e.channel ?? GENERAL_CHANNEL) !== channelRef.current) break
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
      if (snap.openChannel) void switchChannel(snap.openChannel)
    })
    return () => {
      alive = false
      off()
      clearTimeout(typingTimer.current)
    }
  }, [])

  // The old list stays up until the new page is ready, then everything changes in one update.
  // The refs are set here too, so a reveal right after this sees the new channel.
  const switchChannel = useCallback(async (id: string, until?: { id: string; sentAt: number }): Promise<boolean> => {
    const newest = guard.beginSwitch()
    if (id === channelRef.current) return true // also cancels a switch still on its way
    const page = await window.hush.listMessages(undefined, PAGE, id)
    if (!newest()) return false
    const older = until ? await pageBackTo(until, id, page.messages[0], page.hasMore, newest) : { messages: [], more: page.hasMore }
    if (!older) return false
    const loaded = [...older.messages, ...page.messages]
    guard.landed()
    channelRef.current = id
    messagesRef.current = loaded
    hasMoreRef.current = older.more
    loading.current = false
    clearTimeout(typingTimer.current)
    setChannel(id)
    setMessages(loaded)
    setHasMore(older.more)
    setLoadingOlder(false)
    setPeerTyping(false)
    return true
  }, [])

  const loadOlder = useCallback(() => {
    if (loading.current || !hasMore || messages.length === 0) return
    loading.current = true
    setLoadingOlder(true)
    const oldest = messages[0]
    const sameList = guard.watchList()
    void window.hush
      .listMessages({ sentAt: oldest.sentAt, id: oldest.id }, PAGE, channelRef.current)
      .then((page) => {
        if (!sameList()) return
        setMessages((prev) => {
          const ids = new Set(prev.map((m) => m.id))
          return [...page.messages.filter((m) => !ids.has(m.id)), ...prev]
        })
        setHasMore(page.hasMore)
      })
      .finally(() => {
        if (!sameList()) return // the switch has already reset these
        loading.current = false
        setLoadingOlder(false)
      })
  }, [hasMore, messages])

  const reveal = useCallback(async (id: string, sentAt: number): Promise<boolean> => {
    if (messagesRef.current.some((m) => m.id === id)) return true
    if (loading.current) return false
    loading.current = true
    setLoadingOlder(true)
    const sameList = guard.watchList()
    try {
      const older = await pageBackTo({ id, sentAt }, channelRef.current, messagesRef.current[0], hasMoreRef.current, sameList)
      if (!older) return false
      setMessages((prev) => {
        const ids = new Set(prev.map((m) => m.id))
        return [...older.messages.filter((m) => !ids.has(m.id)), ...prev]
      })
      setHasMore(older.more)
      return older.messages.some((m) => m.id === id)
    } finally {
      if (sameList()) {
        loading.current = false
        setLoadingOlder(false)
      }
    }
  }, [])

  const send = useCallback(async (text: string, replyTo: string | undefined, target: string) => {
    // The main process echoes the new message back as a 'message' event.
    await window.hush.sendMessage(text, replyTo, target)
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

  const sendImage = useCallback(async (image: OutgoingImage, caption: string, replyTo: string | undefined, target: string) => {
    await window.hush.sendImage(image, caption, replyTo, target)
  }, [])

  const retryImage = useCallback((id: string) => {
    setTransfer({ id, direction: 'down', state: 'active', progress: 0 })
    window.hush.retryImage(id)
  }, [])

  return {
    snapshot,
    channel,
    switchChannel,
    messages,
    hasMore,
    loadingOlder,
    peerTyping,
    calls,
    notices,
    flush,
    dismissFlush,
    sendImage,
    retryImage,
    loadOlder,
    reveal,
    send,
    markRead,
    updateSettings
  }
}

/** Loads history older than `oldest` until `target` is in it. Null if `valid` stops holding. */
async function pageBackTo(
  target: { id: string; sentAt: number },
  channel: string,
  oldest: ChatMessage | undefined,
  moreHistory: boolean,
  valid: () => boolean
): Promise<{ messages: ChatMessage[]; more: boolean } | null> {
  const messages: ChatMessage[] = []
  let more = moreHistory
  let cursor = oldest
  while (more && cursor && cursor.sentAt >= target.sentAt && !messages.some((m) => m.id === target.id)) {
    const page = await window.hush.listMessages({ sentAt: cursor.sentAt, id: cursor.id }, 500, channel)
    if (!valid()) return null
    messages.unshift(...page.messages)
    more = page.hasMore
    cursor = page.messages[0]
  }
  return { messages, more }
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
