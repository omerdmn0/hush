// Types shared by the main process, preload and renderer.

export type MessageStatus = 'queued' | 'sent' | 'delivered' | 'read'

export interface ChatImage {
  src: string
  width: number
  height: number
  alt?: string
}

export interface ChatMessage {
  /** UUID — also the sync key between the two computers. */
  id: string
  from: 'me' | 'peer'
  text: string
  /** Unix epoch milliseconds, sender's clock. */
  sentAt: number
  /**
   * Mine: queued → sent → delivered → read.
   * Theirs: delivered (unread on this computer) → read.
   */
  status: MessageStatus
  image?: ChatImage
}

/** Position in history used to page backwards (the oldest message currently loaded). */
export interface HistoryCursor {
  sentAt: number
  id: string
}

export interface Settings {
  displayName: string
  peerIp: string
  notifications: boolean
}

export type Presence = 'online' | 'offline'

export interface PeerState {
  /** Learned from their first hello; null until we have ever connected. */
  name: string | null
  presence: Presence
  /** Epoch ms when they were last connected, or null if never. */
  lastSeen: number | null
}

export interface NetState {
  /** This computer's Tailscale IPv4, or null when Tailscale isn't running. */
  ownIp: string | null
  port: number
  /** True when the chat server is accepting connections on ownIp:port. */
  listening: boolean
  /** Human-readable problem, e.g. port already in use or protocol mismatch. */
  error: string | null
}

export interface Snapshot {
  settings: Settings
  peer: PeerState
  net: NetState
}

export type HushEvent =
  | { type: 'message'; message: ChatMessage }
  | { type: 'status'; updates: { id: string; status: MessageStatus }[] }
  | { type: 'peer'; peer: PeerState }
  | { type: 'typing'; on: boolean }
  | { type: 'net'; net: NetState }
  | { type: 'settings'; settings: Settings }

/** API the preload script exposes to the renderer as `window.hush`. */
export interface HushApi {
  platform: string
  getSnapshot(): Promise<Snapshot>
  /** Newest-last page of history; pass the oldest loaded message to page backwards. */
  listMessages(before?: HistoryCursor, limit?: number): Promise<{ messages: ChatMessage[]; hasMore: boolean }>
  sendMessage(text: string): Promise<ChatMessage>
  markRead(ids: string[]): void
  setTyping(on: boolean): void
  updateSettings(patch: Partial<Settings>): Promise<Settings>
  /** Re-detect Tailscale and retry the connection immediately. */
  reconnect(): void
  /** Subscribe to main-process events; returns an unsubscribe function. */
  onEvent(listener: (event: HushEvent) => void): () => void
}

export const IPC = {
  snapshot: 'hush:snapshot',
  listMessages: 'hush:list-messages',
  sendMessage: 'hush:send-message',
  markRead: 'hush:mark-read',
  setTyping: 'hush:set-typing',
  updateSettings: 'hush:update-settings',
  reconnect: 'hush:reconnect',
  event: 'hush:event'
} as const
