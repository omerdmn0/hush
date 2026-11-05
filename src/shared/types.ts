import type { CallSignal } from './protocol'

// Types shared by the main process, preload and renderer.

export type MessageStatus = 'queued' | 'sent' | 'delivered' | 'read'

export interface ChatImage {
  width: number
  height: number
  mime: string
  size: number
  /** Small preview, always available. */
  thumbUrl: string
  /** Full image; only loadable once `ready`. */
  fullUrl: string
  /** True when the full file is stored on this computer. */
  ready: boolean
}

/** Progress of an image moving between the two computers. */
export interface ImageTransfer {
  id: string
  /** 'down' = we are receiving it, 'up' = the other side is pulling it from us. */
  direction: 'down' | 'up'
  state: 'active' | 'done' | 'failed'
  /** 0…1 */
  progress: number
}

export type CallDirection = 'in' | 'out'
export const CALL_OUTCOMES = ['ongoing', 'completed', 'missed', 'declined', 'cancelled', 'no-answer', 'busy', 'failed'] as const
export type CallOutcome = (typeof CALL_OUTCOMES)[number]

/** One call as remembered on this computer (call history). */
export interface CallRecord {
  /** The call's UUID (same on both computers). */
  id: string
  direction: CallDirection
  /** When it started ringing. */
  startedAt: number
  /** When audio connected, if it did. */
  connectedAt: number | null
  endedAt: number | null
  outcome: CallOutcome
}

/** An image picked in the UI, prepared (validated + preview made) by the renderer. */
export interface OutgoingImage {
  bytes: Uint8Array
  mime: string
  width: number
  height: number
  /** Small WebP preview. */
  thumb: Uint8Array
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
  /** Preferred microphone / speaker (MediaDeviceInfo.deviceId); '' = system default. */
  micId: string
  speakerId: string
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

/** hush-img:// URLs of the profile pictures, or null when there is none. */
export interface AvatarUrls {
  self: string | null
  peer: string | null
}

export interface Snapshot {
  settings: Settings
  avatars: AvatarUrls
  /** The window is visible and focused (from the main process, which knows reliably). */
  windowActive: boolean
  peer: PeerState
  net: NetState
  /**
   * Dev pairing mode (two copies over loopback): calls may use any network interface instead of
   * Tailscale only, and test hooks are exposed. Always false in installed builds.
   */
  devPairing: boolean
}

export type HushEvent =
  | { type: 'message'; message: ChatMessage }
  | { type: 'status'; updates: { id: string; status: MessageStatus }[] }
  | { type: 'peer'; peer: PeerState }
  | { type: 'typing'; on: boolean }
  | { type: 'net'; net: NetState }
  | { type: 'settings'; settings: Settings }
  | { type: 'transfer'; transfer: ImageTransfer }
  | { type: 'avatars'; avatars: AvatarUrls }
  /** Window shown/hidden/focused/blurred — read receipts only go out while it's active. */
  | { type: 'window'; active: boolean }
  /** A call-history entry was added or updated. */
  | { type: 'call-log'; record: CallRecord }
  /** WebRTC signaling from the other app. */
  | { type: 'call'; signal: CallSignal }
  /** Messages that were queued while offline have now been delivered. */
  | { type: 'flushed'; count: number; at: number }

/** API the preload script exposes to the renderer as `window.hush`. */
export interface HushApi {
  platform: string
  getSnapshot(): Promise<Snapshot>
  /** Newest-last page of history; pass the oldest loaded message to page backwards. */
  listMessages(before?: HistoryCursor, limit?: number): Promise<{ messages: ChatMessage[]; hasMore: boolean }>
  sendMessage(text: string): Promise<ChatMessage>
  sendImage(image: OutgoingImage, caption: string): Promise<ChatMessage>
  /** Try downloading a failed image again. */
  retryImage(id: string): void
  /** Sends WebRTC signaling to the other app; resolves false if it's offline. */
  sendCallSignal(signal: CallSignal): Promise<boolean>
  listCalls(): Promise<CallRecord[]>
  /** Adds or updates a call-history entry. */
  logCall(record: CallRecord): void
  /** Sets (PNG/JPEG/WebP, ≤ 96 KB) or removes (null) your profile picture. */
  setAvatar(bytes: Uint8Array | null): Promise<boolean>
  /** Quits Hush completely (the window's close button only hides it to the tray). */
  quit(): void
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
  sendImage: 'hush:send-image',
  retryImage: 'hush:retry-image',
  callSignal: 'hush:call-signal',
  listCalls: 'hush:list-calls',
  logCall: 'hush:log-call',
  setAvatar: 'hush:set-avatar',
  quit: 'hush:quit',
  markRead: 'hush:mark-read',
  setTyping: 'hush:set-typing',
  updateSettings: 'hush:update-settings',
  reconnect: 'hush:reconnect',
  event: 'hush:event'
} as const
