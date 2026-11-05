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
  /** Sent by a newer Hush in a form this version can't show ("update Hush to see this"). */
  unsupported?: boolean
  /** When it was last edited (text is the edited version). */
  editedAt?: number
  /** Deleted for everyone by its author: text and picture are gone. */
  deleted?: boolean
  reactions?: Reaction[]
  /** The message this one answers. */
  replyTo?: ReplyPreview
}

/** A search hit: the message's current text (edits applied). */
export interface SearchResult {
  id: string
  from: 'me' | 'peer'
  sentAt: number
  text: string
  hasImage: boolean
}

/** One emoji under a message: who of the two of you added it. */
export interface Reaction {
  emoji: string
  mine: boolean
  theirs: boolean
}

/** What a reply shows of the message it answers. */
export type ReplyPreview =
  | { id: string; missing: false; from: 'me' | 'peer'; text: string; hasImage: boolean; deleted: boolean }
  /** Not on this computer (e.g. deleted for me). */
  | { id: string; missing: true }

/** Position in history used to page backwards (the oldest message currently loaded). */
export interface HistoryCursor {
  sentAt: number
  id: string
}

export interface Settings {
  displayName: string
  peerIp: string
  notifications: boolean
  /** Include message text in notifications. Off = only "New message from Mira" (private). */
  notificationPreview: boolean
  /** Start hidden in the tray when you log in (installed builds only). */
  startAtLogin: boolean
  /** Preferred microphone / speaker (MediaDeviceInfo.deviceId); '' = system default. */
  micId: string
  speakerId: string
}

export type Presence = 'online' | 'offline'

/** Pairing / identity check (shown instead of the chat until paired). */
export interface PairingState {
  /** 'mismatch' = the device at their address has a different identity than the one paired. */
  status: 'paired' | 'unpaired' | 'mismatch'
  /** Connected and ready to pair (both apps running). */
  peerReachable: boolean
  /** Our one-time code to show, "K7P4-QX9M"; null when not pairing. */
  code: string | null
  codeExpiresAt: number | null
  /** They typed our code correctly. */
  theyEnteredMyCode: boolean
  /** We typed their code correctly. */
  iEnteredTheirCode: boolean
  error: string | null
  myFingerprint: string
  peerFingerprint: string | null
  /** Their display name as announced while pairing (before any verified connection). */
  peerName: string | null
}

export interface PeerState {
  /** Learned from their first hello; null until we have ever connected. */
  name: string | null
  presence: Presence
  /** Epoch ms when they were last connected, or null if never. */
  lastSeen: number | null
  /** Their Hush version (last seen), for the "update available" hint. */
  appVersion: string | null
  /**
   * A backup was just restored: writing waits until the other app has synced with us, so new
   * messages can't collide with ones it already has from before the backup.
   */
  catchingUp: boolean
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

/** What the lock window asks for before Hush can open its data. */
export interface LockInfo {
  /** create: no keychain, choose an app password · unlock: enter it · keychain-error: the keychain refused */
  mode: 'create' | 'unlock' | 'keychain-error'
  /** e.g. "GNOME Keyring", "Windows" */
  osName: string
  error?: string
}

export interface AutoBackup {
  enabled: boolean
  folder: string
  attachments: boolean
  /** Time of the last successful automatic backup. */
  last: number | null
  error: string | null
}

/** Settings → Privacy & data. */
export interface PrivacyState {
  /** What protects the encryption key on this computer. */
  protection: 'keychain' | 'password'
  osName: string
  /** A keychain exists, so the app password can be removed. */
  osAvailable: boolean
  autoBackup: AutoBackup
  /** Nothing written on this install yet, so history can be recovered from the other computer. */
  canRecover: boolean
}

export type BackupResult = { ok: true; path: string; bytes: number } | { ok: false; error: string } | { ok: false; cancelled: true }

export interface Snapshot {
  settings: Settings
  privacy: PrivacyState
  avatars: AvatarUrls
  /** The window is visible and focused (from the main process, which knows reliably). */
  windowActive: boolean
  pairing: PairingState
  /** This app's version, e.g. "0.2.0". */
  appVersion: string
  /** Installed build (start-at-login only works there). */
  packaged: boolean
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
  /** An edit/delete/reaction for message `target` arrived or was made (UI re-reads it). */
  | { type: 'event'; target: string }
  | { type: 'avatars'; avatars: AvatarUrls }
  | { type: 'pairing'; pairing: PairingState }
  /** Window shown/hidden/focused/blurred — read receipts only go out while it's active. */
  | { type: 'window'; active: boolean }
  /** A call-history entry was added or updated. */
  | { type: 'call-log'; record: CallRecord }
  /** WebRTC signaling from the other app. */
  | { type: 'call'; signal: CallSignal }
  /** Messages that were queued while offline have now been delivered. */
  | { type: 'flushed'; count: number; at: number }
  | { type: 'privacy'; privacy: PrivacyState }

/** API the preload script exposes to the renderer as `window.hush`. */
export interface HushApi {
  platform: string
  getSnapshot(): Promise<Snapshot>
  /** Newest-last page of history; pass the oldest loaded message to page backwards. */
  listMessages(before?: HistoryCursor, limit?: number): Promise<{ messages: ChatMessage[]; hasMore: boolean }>
  /** `replyTo`: the message this one answers. */
  sendMessage(text: string, replyTo?: string): Promise<ChatMessage>
  sendImage(image: OutgoingImage, caption: string, replyTo?: string): Promise<ChatMessage>
  /** Current state of these messages (after an edit, deletion or reaction); missing = gone. */
  getMessages(ids: string[]): Promise<ChatMessage[]>
  editMessage(id: string, text: string): Promise<void>
  /** "everyone": your own message, erased on both computers. "me": any message, here only. */
  deleteMessage(id: string, mode: 'everyone' | 'me'): Promise<void>
  react(id: string, emoji: string, on: boolean): Promise<void>
  /** Opens an http(s) link in the default browser. */
  openLink(url: string): void
  /** Messages whose current text contains every word of the query, newest first (up to 50). */
  search(query: string): Promise<{ results: SearchResult[]; more: boolean }>
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
  /** Type the code shown on the other person's screen. */
  submitPairingCode(code: string): Promise<void>
  /** Forget the pairing (also "pair again" after an identity change). */
  forgetPairing(): void
  markRead(ids: string[]): void
  setTyping(on: boolean): void
  updateSettings(patch: Partial<Settings>): Promise<Settings>
  /** Re-detect Tailscale and retry the connection immediately. */
  reconnect(): void
  /** Subscribe to main-process events; returns an unsubscribe function. */
  onEvent(listener: (event: HushEvent) => void): () => void

  // ----- lock window (before Hush has opened its data) -----
  lockInfo(): Promise<LockInfo>
  /** Unlocks (or, in "create" mode, sets) the app password. Resolves with an error message, or null on success. */
  lockSubmit(password: string): Promise<string | null>

  // ----- privacy & data -----
  /** Sets or changes the app password, or removes it (null) to use the system keychain again. */
  setAppPassword(password: string | null): Promise<PrivacyState>
  /** Asks where to save, then writes a password-protected backup. */
  backupNow(password: string, attachments: boolean): Promise<BackupResult>
  /** Asks for a backup file and restores it (Hush restarts). Resolves with an error message, or null if cancelled. */
  restoreBackup(password: string): Promise<string | null>
  /** Turns weekly backups on (password needed when turning on or changing it) or off. */
  setAutoBackup(patch: { enabled: boolean; attachments?: boolean; password?: string }): Promise<PrivacyState>
  /** Folder picker for automatic backups. */
  chooseBackupFolder(): Promise<PrivacyState>
  /** Takes back this person's history from the other computer after a reinstall (Hush restarts). */
  recoverHistory(): Promise<string | null>
}

export const IPC = {
  snapshot: 'hush:snapshot',
  listMessages: 'hush:list-messages',
  sendMessage: 'hush:send-message',
  getMessages: 'hush:get-messages',
  editMessage: 'hush:edit-message',
  deleteMessage: 'hush:delete-message',
  react: 'hush:react',
  openLink: 'hush:open-link',
  search: 'hush:search',
  sendImage: 'hush:send-image',
  retryImage: 'hush:retry-image',
  callSignal: 'hush:call-signal',
  listCalls: 'hush:list-calls',
  logCall: 'hush:log-call',
  setAvatar: 'hush:set-avatar',
  pairSubmit: 'hush:pair-submit',
  pairForget: 'hush:pair-forget',
  quit: 'hush:quit',
  markRead: 'hush:mark-read',
  setTyping: 'hush:set-typing',
  updateSettings: 'hush:update-settings',
  reconnect: 'hush:reconnect',
  event: 'hush:event',
  lockInfo: 'hush:lock-info',
  lockSubmit: 'hush:lock-submit',
  setAppPassword: 'hush:set-app-password',
  backupNow: 'hush:backup-now',
  restoreBackup: 'hush:restore-backup',
  setAutoBackup: 'hush:set-auto-backup',
  chooseBackupFolder: 'hush:choose-backup-folder',
  recoverHistory: 'hush:recover-history'
} as const
