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
  /** A file or voice note. */
  file?: ChatFile
  /** Sent by a newer Hush in a form this version can't show ("update Hush to see this"). */
  unsupported?: boolean
  /** When it was last edited (text is the edited version). */
  editedAt?: number
  /** Deleted for everyone by its author: text and picture are gone. */
  deleted?: boolean
  reactions?: Reaction[]
  /** The message this one answers. */
  replyTo?: ReplyPreview
  /** The channel it belongs to; absent means General. */
  channel?: string
}

/** A text channel between the two of you. General has the id ''. */
export interface ChannelInfo {
  id: string
  name: string
  /** No desktop notifications from it on this computer; never told to the other person. */
  muted?: boolean
}

export interface ChatFile {
  name: string
  size: number
  mime: string
  /** The whole file is on this computer (can be saved / played). */
  ready: boolean
  /** Runs code when opened (.exe, .sh, .AppImage…): shown with a warning. */
  risky: boolean
  /** Big files from the other person download only when asked. */
  autoDownload: boolean
  voice?: { durationMs: number; peaks: number[]; url: string }
}

/** A search hit: the message's current text (edits applied). */
export interface SearchResult {
  id: string
  from: 'me' | 'peer'
  sentAt: number
  text: string
  hasImage: boolean
  /** The channel it's in; absent means General. */
  channel?: string
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
  /** Their Hush can receive a shared screen (false while offline or on an older version). */
  canShare: boolean
  /** Their Hush supports channels, as last seen (kept while offline). */
  channelsReady: boolean
}

/** A screen or window that can be shared. */
export interface ScreenSource {
  id: string
  name: string
  /** Small preview (data: URL). */
  thumb: string
}

/** An app that is playing sound right now (Linux; can be shared on its own). */
export interface AudioApp {
  key: string
  name: string
}

/** How screen audio works on this computer. Work in progress — see README. */
export type ScreenAudioSupport =
  /** PipeWire: every app except Hush, or chosen apps. */
  | { kind: 'linux'; apps: AudioApp[] }
  /** Windows: everything except Hush, through the helper program. Not tested yet. */
  | { kind: 'windows' }
  | { kind: 'none'; reason: string }

export interface ShareOptions {
  /** null: the system asks which screen to share (Linux on Wayland). */
  sources: ScreenSource[] | null
  audio: ScreenAudioSupport
}

/** 'all' = everything except Hush; otherwise the `key` of an AudioApp. */
export type ScreenAudioTarget = string

export type ScreenAudioStarted =
  /** Capture it as a microphone with this label. */
  | { ok: true; deviceLabel: string }
  /** Raw audio arrives through onScreenPcm (s16le, stereo, 48 kHz). */
  | { ok: true; pcm: true }
  | { ok: false; error: string }

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
  /** General first, then the rest, oldest first. */
  channels: ChannelInfo[]
  /** Unread messages per channel id; channels with none are left out. */
  unread: Record<string, number>
  /** A notification was clicked before this window was ready: open this channel. */
  openChannel?: string
  net: NetState
  /**
   * Dev pairing mode (two copies over loopback): calls may use any network interface instead of
   * Tailscale only, and test hooks are exposed. Always false in installed builds.
   */
  devPairing: boolean
}

export type UpdateState =
  | { status: 'idle' }
  /** A build or install type that can't replace itself. */
  | { status: 'unsupported' }
  | { status: 'checking' }
  | { status: 'current' }
  | { status: 'available'; version: string }
  | { status: 'downloading'; version: string; percent: number }
  /** `blocked` says what restarting now would interrupt, until the user confirms. */
  | { status: 'ready'; version: string; blocked?: string }
  | { status: 'installing'; version: string }
  | { status: 'error'; message: string }

export type HushEvent =
  | { type: 'message'; message: ChatMessage }
  | { type: 'status'; updates: { id: string; status: MessageStatus }[] }
  | { type: 'peer'; peer: PeerState }
  | { type: 'typing'; on: boolean; channel?: string }
  | { type: 'net'; net: NetState }
  | { type: 'settings'; settings: Settings }
  | { type: 'transfer'; transfer: ImageTransfer }
  /** The channel list changed; `erased` is a channel just deleted for good. */
  | { type: 'channels'; channels: ChannelInfo[]; erased?: string }
  /** Unread messages per channel id; channels with none are left out. */
  | { type: 'unread'; byChannel: Record<string, number> }
  /** A notification was clicked: show this channel. */
  | { type: 'open-channel'; channel: string }
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
  | { type: 'update'; update: UpdateState }
  /** The window went to the tray. */
  | { type: 'hidden' }

/** API the preload script exposes to the renderer as `window.hush`. */
export interface HushApi {
  platform: string
  getSnapshot(): Promise<Snapshot>
  /** Newest-last page of history; pass the oldest loaded message to page backwards. */
  listMessages(before?: HistoryCursor, limit?: number, channel?: string): Promise<{ messages: ChatMessage[]; hasMore: boolean }>
  /** `replyTo`: the message this one answers. */
  sendMessage(text: string, replyTo?: string, channel?: string): Promise<ChatMessage>
  createChannel(name: string): Promise<ChannelInfo>
  renameChannel(id: string, name: string): Promise<void>
  /** Permanently erases the channel and everything in it, on both computers. */
  deleteChannel(id: string): Promise<void>
  setChannelMuted(id: string, muted: boolean): void
  sendImage(image: OutgoingImage, caption: string, replyTo?: string, channel?: string): Promise<ChatMessage>
  /** Current state of these messages (after an edit, deletion or reaction); missing = gone. */
  getMessages(ids: string[]): Promise<ChatMessage[]>
  editMessage(id: string, text: string): Promise<void>
  /** "everyone": your own message, erased on both computers. "me": any message, here only. */
  deleteMessage(id: string, mode: 'everyone' | 'me'): Promise<void>
  react(id: string, emoji: string, on: boolean): Promise<void>
  /** Opens an http(s) link in the default browser. */
  openLink(url: string): void
  /**
   * Sends a file the user picked, dropped or pasted. Files on disk can be up to 1 GB (Hush reads
   * them itself); pasted ones up to 25 MB.
   */
  sendFile(file: File, caption: string, replyTo?: string, channel?: string): Promise<ChatMessage>
  /** A recorded voice note (WebM/Opus, ≤ 5 min) with its waveform (≤ 48 bars, 0–255). */
  sendVoice(bytes: Uint8Array, durationMs: number, peaks: Uint8Array, replyTo?: string, channel?: string): Promise<ChatMessage>
  /** Starts downloading a big file (or retries a failed one). */
  downloadFile(id: string): void
  /** Asks where to save an image or file and writes a copy there (programs get a warning first). */
  saveAttachment(id: string): Promise<{ saved: string } | { cancelled: true } | { error: string }>
  /** Shows a file Hush just saved in the file manager. */
  showInFolder(path: string): void
  /** What can be shared, and how screen audio works on this computer. */
  shareOptions(): Promise<ShareOptions>
  /** The screen or window the next capture should use (null: the system asks). */
  shareChoose(sourceId: string | null): Promise<void>
  /** Starts capturing screen audio, without Hush's own sound. */
  screenAudioStart(target: ScreenAudioTarget): Promise<ScreenAudioStarted>
  screenAudioStop(): void
  /** Raw screen audio (Windows). Returns an unsubscribe function. */
  onScreenPcm(listener: (pcm: Uint8Array) => void): () => void
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
  setTyping(on: boolean, channel?: string): void
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
  updateState(): Promise<UpdateState>
  checkForUpdate(): Promise<void>
  /** Downloads the update found by the last check. */
  downloadUpdate(): Promise<void>
  /** Restarts into the downloaded update. `anyway` confirms interrupting a call or transfer. */
  installUpdate(anyway: boolean): Promise<void>
}

export const IPC = {
  snapshot: 'hush:snapshot',
  listMessages: 'hush:list-messages',
  sendMessage: 'hush:send-message',
  createChannel: 'hush:create-channel',
  renameChannel: 'hush:rename-channel',
  deleteChannel: 'hush:delete-channel',
  setChannelMuted: 'hush:set-channel-muted',
  getMessages: 'hush:get-messages',
  editMessage: 'hush:edit-message',
  deleteMessage: 'hush:delete-message',
  react: 'hush:react',
  openLink: 'hush:open-link',
  search: 'hush:search',
  shareOptions: 'hush:share-options',
  shareChoose: 'hush:share-choose',
  screenAudioStart: 'hush:screen-audio-start',
  screenAudioStop: 'hush:screen-audio-stop',
  screenPcm: 'hush:screen-pcm',
  sendFilePath: 'hush:send-file-path',
  sendFileBytes: 'hush:send-file-bytes',
  downloadFile: 'hush:download-file',
  saveAttachment: 'hush:save-attachment',
  showInFolder: 'hush:show-in-folder',
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
  recoverHistory: 'hush:recover-history',
  updateState: 'hush:update-state',
  updateCheck: 'hush:update-check',
  updateDownload: 'hush:update-download',
  updateInstall: 'hush:update-install'
} as const
