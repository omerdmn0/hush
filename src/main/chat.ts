import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import { stat } from 'node:fs/promises'
import {
  cleanChannelName,
  GENERAL_CHANNEL,
  IMAGE_MIME,
  isUuid,
  MAX_CHANNELS,
  MAX_FILE_BYTES,
  MAX_IMAGE_BYTES,
  MAX_MEMORY_FILE_BYTES,
  MAX_TEXT_LENGTH,
  MAX_VOICE_MS,
  parseFileMeta,
  sniffImage,
  VOICE_PEAKS,
  type FileMeta,
  type Frame,
  type ImageMeta,
  type ImageMime
} from '../shared/protocol'
import { cleanFileName, guessMime } from '../shared/files'
import type { ChannelInfo, ChatMessage, HistoryCursor, HushEvent, OutgoingImage, PeerState, SearchResult } from '../shared/types'
import { fold, matchesAll, queryTerms } from '../shared/search'
import { toChatMessage, type HushDb, type StoredMessage } from './db'
import { applyEvents, isReactionEmoji, reactionData } from './events'
import { blobOf, sha256, type ImageStore } from './images'
import type { LinkPeer, PeerLink } from './link'
import type { Avatars } from './avatars'
import { Transfers } from './transfers'

/** Messages re-sent per database page during sync. */
const SYNC_PAGE = 200
/** Incoming messages are acknowledged in one batch after this short pause. */
const ACK_BATCH_MS = 50
/** "N queued messages delivered" is reported once deliveries go quiet for this long. */
const FLUSH_QUIET_MS = 600
/** Inline previews larger than this are refused (as base64 they must pass MAX_THUMB_BASE64). */
const MAX_THUMB_BYTES = 150_000
const PREVIEW_TYPES = new Set<string>(['image/webp', 'image/jpeg', 'image/png'])
/** A transparent 1×1 PNG, sent when an image's real preview can't be read. */
const BLANK_PREVIEW = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

/** Setting: a backup was restored and the peer hasn't synced with us since. */
export const AWAITING_SYNC = 'awaitingSync'
/** Setting: channel ids silenced on this computer. */
const MUTED_CHANNELS = 'mutedChannels'
/** The in-memory search text is dropped after this long without a search. */
const SEARCH_IDLE_MS = 10 * 60_000

/**
 * Chat logic on top of a PeerLink: stores messages, sends receipts, tracks presence, and
 * runs the sync exchange on every connection (see protocol.ts for the model).
 *
 * Offline queue: a message written while the peer is away is stored as `queued`. On the next
 * connection the peer's `sync` frame says which of our messages it already holds; everything
 * after that is re-sent, acked, and moves to `delivered`.
 */
export class ChatService {
  private ackQueue: string[] = []
  private ackTimer: ReturnType<typeof setTimeout> | undefined
  /** Our messages that were queued when the connection came up — counted for the flush notice. */
  private flushWatch = new Set<string>()
  private flushCount = 0
  private flushTimer: ReturnType<typeof setTimeout> | undefined
  readonly transfers: Transfers
  private readonly avatars: Avatars | null
  private readonly emit: (e: HushEvent) => void

  constructor(
    private readonly db: HushDb,
    private readonly link: PeerLink,
    private readonly selfId: string,
    emit: (e: HushEvent) => void,
    private readonly store: ImageStore,
    opts: { chunkBytes?: number; avatars?: Avatars } = {}
  ) {
    // Everything the UI hears about also keeps the search text up to date.
    this.emit = (e) => {
      if (e.type === 'message') this.searchUpdate(e.message.id)
      else if (e.type === 'event') this.searchUpdate(e.target)
      emit(e)
    }
    this.avatars = opts.avatars ?? null
    this.transfers = new Transfers(db, store, link, emit, opts.chunkBytes)
    link.on('up', (peer) => this.onUp(peer))
    link.on('down', () => this.onDown())
    // One frame that can't be applied (e.g. it clashes with what's stored) must not stop the rest.
    link.on('frame', (frame, peer) => void this.onFrame(frame, peer).catch((e: unknown) => console.error(`Couldn't apply a '${frame.t}' frame:`, (e as Error).message)))
  }

  peerState(): PeerState {
    return {
      name: this.db.getSetting<string>('peerName') ?? null,
      presence: this.link.peer ? 'online' : 'offline',
      lastSeen: this.db.getSetting<number>('peerLastSeen') ?? null,
      appVersion: this.db.getSetting<string>('peerApp') ?? null,
      catchingUp: !!this.db.getSetting<boolean>(AWAITING_SYNC),
      canShare: this.link.peer?.features.includes('screen') ?? false,
      channelsReady: this.channelsReady()
    }
  }

  /** After a restore, nothing new is written until the peer has told us what it holds. */
  private assertCanWrite(): void {
    if (this.db.getSetting<boolean>(AWAITING_SYNC)) throw new Error('Catching up with the other computer first')
  }

  listMessages(before: HistoryCursor | undefined, limit: number, channel: string = GENERAL_CHANNEL): { messages: ChatMessage[]; hasMore: boolean } {
    const { rows, hasMore } = this.db.listMessages(before, Math.min(Math.max(limit, 1), 500), channel)
    return { messages: this.decorate(rows), hasMore }
  }

  /** Current state of these messages for the UI (left out: unknown, or deleted for me). */
  getMessages(ids: string[]): ChatMessage[] {
    return this.decorate(this.db.getMessages(ids.slice(0, 500)).filter((m) => !m.ref))
  }

  /** Hush is closing (before the database closes): stop every timer. */
  dispose(): void {
    clearTimeout(this.ackTimer)
    clearTimeout(this.flushTimer)
    clearTimeout(this.searchIdle)
    this.searchText = null
    this.transfers.dispose()
  }

  // ---------- search ----------
  // History is encrypted on disk, so there is no search index there. The first search decrypts
  // the current text of every message into memory; it's kept up to date while in use and
  // dropped after SEARCH_IDLE_MS without a search.

  private searchText: Map<string, SearchEntry> | null = null
  private searchIdle: ReturnType<typeof setTimeout> | undefined

  search(query: string, limit = 50): { results: SearchResult[]; more: boolean } {
    const terms = queryTerms(query.slice(0, 200))
    if (terms.length === 0) return { results: [], more: false }
    this.searchText ??= this.buildSearch()
    clearTimeout(this.searchIdle)
    this.searchIdle = setTimeout(() => (this.searchText = null), SEARCH_IDLE_MS)
    this.searchIdle.unref?.() // never keeps the process alive
    const hits: SearchEntry[] = []
    for (const e of this.searchText.values()) if (matchesAll(e.folded, terms)) hits.push(e)
    hits.sort((a, b) => b.sentAt - a.sentAt || (b.id < a.id ? -1 : 1))
    return { results: hits.slice(0, limit).map(({ folded: _, ...r }) => r), more: hits.length > limit }
  }

  private buildSearch(): Map<string, SearchEntry> {
    const { messages, events } = this.db.searchSource()
    const byRef = new Map<string, StoredMessage[]>()
    for (const e of events) byRef.set(e.ref!, [...(byRef.get(e.ref!) ?? []), e])
    const out = new Map<string, SearchEntry>()
    const channels = this.channelMap()
    for (const m of messages) {
      if (m.channel && !channels.has(m.channel)) continue
      const state = applyEvents(m.authorId, byRef.get(m.id) ?? [], this.selfId)
      if (state.deleted) continue
      const text = [state.text ?? m.body, m.file?.voice ? '' : (m.file?.name ?? '')].filter(Boolean).join(' · ')
      const entry = this.searchEntry(m.id, m.authorId === this.selfId ? 'me' : 'peer', m.sentAt, text, !!m.image, m.channel)
      if (entry) out.set(m.id, entry)
    }
    return out
  }

  private searchEntry(id: string, from: 'me' | 'peer', sentAt: number, text: string, hasImage: boolean, channel?: string): SearchEntry | null {
    return text ? { id, from, sentAt, text, hasImage, ...(channel ? { channel } : {}), folded: fold(text).text } : null
  }

  /** A message appeared or changed: refresh its search text (only while search is in use). */
  private searchUpdate(id: string): void {
    if (!this.searchText) return
    const m = this.getMessages([id])[0]
    const text = m ? [m.text, m.file && !m.file.voice ? m.file.name : ''].filter(Boolean).join(' · ') : ''
    const known = !m?.channel || this.channelMap().has(m.channel)
    const entry = m && known && !m.deleted && !m.unsupported ? this.searchEntry(m.id, m.from, m.sentAt, text, !!m.image, m.channel) : null
    if (entry) this.searchText.set(id, entry)
    else this.searchText.delete(id)
  }

  /** A reply must point at a chat message we have, in the same channel. */
  private checkReply(replyTo: string | undefined, channel: string): string | null {
    if (replyTo === undefined) return null
    const target = isUuid(replyTo) ? this.db.getMessage(replyTo) : undefined
    if (!target || target.ref || (target.channel ?? GENERAL_CHANNEL) !== channel) throw new Error('That message is gone')
    return target.id
  }

  /** Something may only be written to General, or to a channel that exists on both sides. */
  private checkChannel(channel: string): void {
    if (channel !== GENERAL_CHANNEL && (!this.channelMap().has(channel) || !this.channelsReady())) throw new Error('That channel is gone')
  }

  /** A peer without channels would drop the channel id and lose the message's place for good. */
  private channelsReady(): boolean {
    return !!this.db.getSetting<boolean>('peerChannels')
  }

  /** Validates an image prepared by the UI, stores it, and sends it like a message. */
  async sendImage(img: OutgoingImage, caption: string, replyTo?: string, channel: string = GENERAL_CHANNEL): Promise<ChatMessage> {
    this.assertCanWrite()
    this.checkChannel(channel)
    const reply = this.checkReply(replyTo, channel)
    const body = caption.trim()
    const mime = img.mime as ImageMime
    const valid =
      IMAGE_MIME.includes(mime) &&
      img.bytes.length > 0 &&
      img.bytes.length <= MAX_IMAGE_BYTES &&
      sniffImage(img.bytes) === mime &&
      img.thumb.length > 0 &&
      img.thumb.length <= MAX_THUMB_BYTES &&
      PREVIEW_TYPES.has(sniffImage(img.thumb) ?? '') &&
      [img.width, img.height].every((n) => Number.isInteger(n) && n >= 1 && n <= 20_000) &&
      body.length <= MAX_TEXT_LENGTH
    if (!valid) throw new Error('Not a supported image')

    const meta: ImageMeta = { mime, width: img.width, height: img.height, size: img.bytes.length, sha256: sha256(img.bytes) }
    const id = randomUUID()
    this.store.saveOwn(id, meta, img.bytes, img.thumb)
    const stored = this.db.createOwnMessage(this.selfId, body, Date.now(), meta, id, null, reply, null, channel)
    this.emit({ type: 'message', message: this.toChat(stored) })
    const ok = await this.link.send(this.msgFrame(stored))
    if (ok) this.advanceMine([stored.id], 'sent')
    return this.toChat(this.db.getMessage(stored.id)!)
  }

  async send(text: string, replyTo?: string, channel: string = GENERAL_CHANNEL): Promise<ChatMessage> {
    this.assertCanWrite()
    this.checkChannel(channel)
    const body = text.trim()
    if (!body || body.length > MAX_TEXT_LENGTH) throw new Error('Message is empty or too long')
    const reply = this.checkReply(replyTo, channel)
    const stored = this.db.createOwnMessage(this.selfId, body, Date.now(), null, undefined, null, reply, null, channel)
    this.emit({ type: 'message', message: this.toChat(stored) })

    // Offline: stays queued and goes out with the next sync.
    const ok = await this.link.send(this.msgFrame(stored))
    if (ok) this.advanceMine([stored.id], 'sent')
    return this.toChat(this.db.getMessage(stored.id)!)
  }

  /**
   * Sends a file from disk (any type, up to 1 GB). It's copied into the encrypted store first —
   * streamed, never read whole — then sent like any message; the bytes follow in chunks.
   */
  async sendFile(path: string, caption: string, replyTo?: string, channel: string = GENERAL_CHANNEL): Promise<ChatMessage> {
    this.assertCanWrite()
    this.checkChannel(channel)
    const body = caption.trim()
    if (body.length > MAX_TEXT_LENGTH) throw new Error('Caption too long')
    const reply = this.checkReply(replyTo, channel)
    const info = await stat(path)
    if (!info.isFile() || info.size === 0 || info.size > MAX_FILE_BYTES) throw new Error('Files can be up to 1 GB')
    const id = randomUUID()
    const name = cleanFileName(basename(path))
    const { size, sha256: hash } = await this.store.importFile(id, path, MAX_FILE_BYTES)
    return this.sendFileMessage(id, { name, size, mime: guessMime(name), sha256: hash }, body, reply, channel)
  }

  /** A small file from memory: pasted (≤ 25 MB) or a voice note (≤ 5 min). */
  async sendFileBytes(
    bytes: Uint8Array,
    rawName: string,
    caption: string,
    replyTo?: string,
    voice?: { durationMs: number; peaks: Uint8Array },
    channel: string = GENERAL_CHANNEL
  ): Promise<ChatMessage> {
    this.assertCanWrite()
    this.checkChannel(channel)
    const body = caption.trim()
    if (body.length > MAX_TEXT_LENGTH) throw new Error('Caption too long')
    if (bytes.length === 0 || bytes.length > MAX_MEMORY_FILE_BYTES) throw new Error('Pasted files can be up to 25 MB')
    const reply = this.checkReply(replyTo, channel)
    const name = cleanFileName(rawName)
    const id = randomUUID()
    const meta: FileMeta = { name, size: bytes.length, mime: guessMime(name), sha256: '' }
    if (voice) {
      const ok = Number.isSafeInteger(voice.durationMs) && voice.durationMs > 0 && voice.durationMs <= MAX_VOICE_MS + 1000 && voice.peaks.length <= VOICE_PEAKS
      if (!ok) throw new Error('Invalid voice note')
      meta.mime = 'audio/webm'
      meta.voice = { durationMs: voice.durationMs, peaks: Buffer.from(voice.peaks).toString('base64') }
    }
    meta.sha256 = this.store.saveOwnBytes(id, voice ? 'voice' : 'file', bytes)
    if (!parseFileMeta(meta)) throw new Error('Invalid file')
    return this.sendFileMessage(id, meta, body, reply, channel)
  }

  private async sendFileMessage(id: string, meta: FileMeta, body: string, reply: string | null, channel: string): Promise<ChatMessage> {
    // Copying a big file takes a while: the channel may have been deleted meanwhile.
    if (channel && this.db.channelDeleted(channel)) {
      this.store.remove(id)
      throw new Error('That channel is gone')
    }
    const stored = this.db.createOwnMessage(this.selfId, body, Date.now(), null, id, null, reply, meta, channel)
    this.emit({ type: 'message', message: this.toChat(stored) })
    if (await this.link.send(this.msgFrame(stored))) this.advanceMine([stored.id], 'sent')
    return this.toChat(this.db.getMessage(stored.id)!)
  }

  /** Download a big file (they don't come by themselves), or retry a failed download. */
  download(id: string): void {
    this.transfers.retry(id)
  }

  /** Stops a download or a send until the user asks for it again. */
  cancelTransfer(id: string): void {
    this.transfers.stop(id)
  }

  /** Writes a decrypted copy of an image or file to `dest` (chosen by the user). */
  async exportAttachment(id: string, dest: string): Promise<void> {
    const m = isUuid(id) ? this.db.getMessage(id) : undefined
    const meta = m ? blobOf(m) : null
    if (!meta || !this.store.hasFull(id, meta)) throw new Error('Not downloaded yet')
    await this.store.exportTo(id, meta, dest)
  }

  /** The user has seen these incoming messages. */
  markRead(ids: string[]): void {
    const changed = this.db.advanceStatusFromOthers(ids, 'read', this.selfId)
    if (changed.length === 0) return
    // The receipt covers everything before it in that channel, including history not loaded on
    // screen yet. Other channels are untouched: reading one says nothing about the rest.
    const channels = [...new Set(this.db.getMessages(changed, true).map((m) => m.channel ?? GENERAL_CHANNEL))]
    const peerId = this.db.getSetting<string>('peerId')
    if (peerId) for (const c of channels) changed.push(...this.db.advanceReadUpTo(peerId, this.db.readSeq(peerId, c), c))
    this.emit({ type: 'status', updates: changed.map((id) => ({ id, status: 'read' })) })
    // Offline: the watermarks go out on the next connection instead.
    const online = this.link.peer?.id
    if (online) for (const c of channels) void this.link.send({ t: 'read', author: online, upTo: this.db.readSeq(online, c), ...channelField(c) })
  }

  setTyping(on: boolean, channel: string = GENERAL_CHANNEL): void {
    void this.link.send({ t: 'typing', on, ...channelField(channel) })
  }

  // ---------- link events ----------

  /** New active connection (also after a duplicate-connection switch): re-sync. Idempotent. */
  private onUp(peer: LinkPeer): void {
    this.rememberPeer(peer)
    for (const id of this.db.idsWithStatus(this.selfId, ['queued'])) this.flushWatch.add(id)
    this.emit({ type: 'peer', peer: this.peerState() })
    const read = this.db.readWatermarks(peer.id)
    void this.link.send({
      t: 'sync',
      have: { [this.selfId]: this.db.contiguousSeq(this.selfId), [peer.id]: this.db.contiguousSeq(peer.id) },
      read: { [peer.id]: read.get(GENERAL_CHANNEL) ?? 0 }
    })
    // Not in `sync`: its maps are capped, and one over the cap would refuse the whole frame.
    for (const [channel, upTo] of read) {
      if (channel !== GENERAL_CHANNEL && this.channelMap().has(channel)) void this.link.send({ t: 'read', author: peer.id, upTo, channel })
    }
    this.transfers.onUp()
    if (this.avatars) void this.link.send({ t: 'avatar', data: this.avatars.selfBase64() })
  }

  /** Sets or removes our profile picture and tells the other app. */
  setAvatar(bytes: Uint8Array | null): boolean {
    if (!this.avatars?.setSelf(bytes)) return false
    this.emit({ type: 'avatars', avatars: this.avatars.urls() })
    void this.link.send({ t: 'avatar', data: this.avatars.selfBase64() })
    return true
  }

  private onDown(): void {
    this.transfers.onDown()
    this.db.setSetting('peerLastSeen', Date.now())
    this.emit({ type: 'typing', on: false })
    this.emit({ type: 'peer', peer: this.peerState() })
  }

  private async onFrame(frame: Frame, peer: LinkPeer): Promise<void> {
    switch (frame.t) {
      case 'msg': {
        // On a direct link the author must be the connected peer — or us, when the peer sends
        // back our own messages after we recovered our history from it.
        const own = frame.author === this.selfId
        if (frame.author !== peer.id && !own) return
        // Coming back can only fill in what we already numbered: anything newer is someone
        // else writing in our name.
        if (own && frame.seq > this.highestOwnSeq()) return
        const channel = (frame.kind === 'channel' || frame.kind === 'channel-del' ? frame.ref : frame.channel) ?? GENERAL_CHANNEL
        // Late for a channel that's gone (an edit made offline, say): keep the sequence number,
        // nothing else. This comes first so even an image preview never reaches the disk.
        if (channel && frame.kind !== 'channel-del' && this.db.channelDeleted(channel)) {
          this.db.insertMessage({
            id: frame.id,
            authorId: frame.author,
            seq: frame.seq,
            body: '',
            sentAt: frame.sentAt,
            status: 'delivered',
            image: null,
            kind: frame.kind ?? 'message',
            ref: frame.ref ?? null,
            channel,
            hidden: true
          })
          if (!own) this.queueAck(frame.id)
          break
        }
        let image: ImageMeta | null = null
        if (frame.image) {
          const { thumb, ...meta } = frame.image
          // Store the preview before the message, so the UI never shows a message without it.
          if (!this.db.getMessage(frame.id)) {
            const bytes = Buffer.from(thumb, 'base64')
            if (!PREVIEW_TYPES.has(sniffImage(bytes) ?? '') || bytes.length > MAX_THUMB_BYTES) return
            this.store.saveThumb(frame.id, bytes)
          }
          image = meta
        }
        const stored: StoredMessage = {
          id: frame.id,
          authorId: frame.author,
          seq: frame.seq,
          body: frame.body,
          sentAt: frame.sentAt,
          status: 'delivered',
          image,
          kind: frame.kind ?? 'message',
          ref: frame.ref ?? null,
          data: frame.data ?? null,
          replyTo: frame.reply ?? null,
          file: frame.file ?? null,
          channel
        }
        if (frame.kind === 'channel-del' && channel) {
          this.eraseChannel(channel, () => this.db.insertMessage(stored))
        } else if (this.db.insertMessage(stored)) {
          // Events (edit/delete/react) are stored and acked like messages; the UI applies them.
          if (frame.kind === 'channel') {
            this.channelsChanged()
          } else if (stored.ref) {
            // Deleted for everyone by its author: erase it here too.
            const target = stored.kind === 'delete' ? this.db.getMessage(stored.ref) : undefined
            if (target && target.authorId === stored.authorId) this.erase(target.id)
            this.emit({ type: 'event', target: stored.ref })
          } else {
            if (!own) this.emit({ type: 'typing', on: false, ...channelField(channel) })
            this.emit({ type: 'message', message: this.toChat(stored) })
            if (image || stored.file) this.transfers.want(stored.id)
          }
        }
        // Always ack, even duplicates — the sender may have missed the first ack.
        if (!own) this.queueAck(frame.id)
        break
      }
      case 'sync':
        await this.onSync(frame, peer)
        break
      case 'recover-req': {
        const id = this.db.getSetting<string>('previousPeerId') ?? null
        void this.link.send({ t: 'recover', id, seq: id ? this.db.maxSeq(id) : 0 })
        break
      }
      case 'recover':
        this.recoverWaiter?.(frame)
        break
      case 'blob-req':
      case 'blob-err':
        this.transfers.onFrame(frame)
        break
      case 'ack':
        this.advanceMine(frame.ids, 'delivered')
        break
      case 'read':
        if (frame.author === this.selfId) this.applyChanges(this.db.advanceReadUpTo(this.selfId, frame.upTo, frame.channel ?? GENERAL_CHANNEL), 'read')
        break
      case 'typing':
        this.emit({ type: 'typing', on: frame.on, ...channelField(frame.channel ?? GENERAL_CHANNEL) })
        break
      case 'avatar':
        if (this.avatars?.setPeer(frame.data === null ? null : Buffer.from(frame.data, 'base64'))) {
          this.emit({ type: 'avatars', avatars: this.avatars.urls() })
        }
        break
      case 'profile':
        this.rememberPeer(peer)
        this.emit({ type: 'peer', peer: this.peerState() })
        break
      case 'hello':
        break
    }
  }

  /**
   * The peer told us what it holds and has read; catch up statuses and send what it lacks —
   * our messages, and its own ones it no longer has (after it recovered its history from us).
   */
  private async onSync(frame: Extract<Frame, { t: 'sync' }>, peer: LinkPeer): Promise<void> {
    const theyHave = frame.have[this.selfId] ?? 0
    // They hold more of our messages than we do (we restored an older backup): number new ones
    // after theirs — the missing ones come back below, through their own sync.
    if (theyHave > this.highestOwnSeq()) this.db.setSetting(`seqFloor:${this.selfId}`, theyHave)
    if (this.db.getSetting<boolean>(AWAITING_SYNC)) {
      this.db.setSetting(AWAITING_SYNC, null)
      this.emit({ type: 'peer', peer: this.peerState() })
    }
    this.applyChanges(this.db.advanceUpTo(this.selfId, theyHave, 'delivered'), 'delivered')
    this.applyChanges(this.db.advanceReadUpTo(this.selfId, frame.read[this.selfId] ?? 0, GENERAL_CHANNEL), 'read')

    if (!(await this.sendAfter(this.selfId, theyHave, true))) return
    const theirOwn = frame.have[peer.id] ?? 0
    if (this.db.contiguousSeq(peer.id) > theirOwn) await this.sendAfter(peer.id, theirOwn, false)
  }

  /** Sends `author`'s messages after a sequence number, in pages. False if the link dropped. */
  private async sendAfter(author: string, after: number, mine: boolean): Promise<boolean> {
    for (;;) {
      const page = this.db.messagesAfter(author, after, SYNC_PAGE)
      if (page.length === 0) return true
      for (const m of page) {
        // Erased since this page was read (a delete can land mid-sync): its preview is gone.
        const row = m.image ? (this.db.getMessage(m.id) ?? m) : m
        if (!(await this.link.send(this.msgFrame(row)))) return false // next sync resumes
        if (mine) this.advanceMine([m.id], 'sent')
        after = m.seq!
      }
    }
  }

  /** The last number this install has written, or knows it wrote before losing its history. */
  private highestOwnSeq(): number {
    return Math.max(this.db.maxSeq(this.selfId), this.db.getSetting<number>(`seqFloor:${this.selfId}`) ?? 0)
  }

  private recoverWaiter: ((f: Extract<Frame, { t: 'recover' }>) => void) | null = null

  /** Whether this install has written anything yet (recovery is only offered before that). */
  hasOwnMessages(): boolean {
    return this.db.maxSeq(this.selfId) > 0
  }

  /**
   * Asks the paired app for the device id it knew us by before a reinstall. Resolves with that
   * id and its last sequence number, or null if it has none (or doesn't answer in 10 s).
   */
  async askPreviousId(): Promise<{ id: string; seq: number } | null> {
    if (!this.link.peer?.features.includes('recover')) return null
    const answer = new Promise<Extract<Frame, { t: 'recover' }> | null>((resolve) => {
      const timer = setTimeout(() => resolve(null), 10_000)
      this.recoverWaiter = (f) => {
        clearTimeout(timer)
        resolve(f)
      }
    })
    if (!(await this.link.send({ t: 'recover-req' }))) return null
    const f = await answer
    this.recoverWaiter = null
    return f?.id && f.id !== this.selfId ? { id: f.id, seq: f.seq } : null
  }

  // ---------- helpers ----------

  /** A preview lost to disk damage must not stop everything after it from being delivered. */
  private previewBase64(id: string): string {
    try {
      return this.store.readThumbBase64(id)
    } catch {
      return BLANK_PREVIEW
    }
  }

  private msgFrame(m: StoredMessage): Frame {
    const frame: Extract<Frame, { t: 'msg' }> = { t: 'msg', id: m.id, author: m.authorId, seq: m.seq!, body: m.body, sentAt: m.sentAt }
    if (m.image) frame.image = { ...m.image, thumb: this.previewBase64(m.id) }
    if (m.kind && m.kind !== 'message') frame.kind = m.kind
    if (m.ref) frame.ref = m.ref
    if (m.data != null) frame.data = m.data
    if (m.replyTo) frame.reply = m.replyTo
    if (m.file) frame.file = m.file
    if (m.channel) frame.channel = m.channel
    return frame
  }

  /**
   * Records an event (edit / delete / react) on message `ref` and sends it. Like messages, it
   * waits in the queue while the other app is offline and goes out with the next sync.
   */
  async sendEvent(kind: 'edit' | 'delete' | 'react', ref: string, data: string | null): Promise<StoredMessage> {
    this.assertCanWrite()
    // Stamped with its message's channel, so deleting the channel erases this too.
    const stored = this.db.createOwnMessage(this.selfId, '', Date.now(), null, undefined, { kind, ref, data }, null, null, this.db.getMessage(ref)?.channel)
    this.emit({ type: 'event', target: ref })
    if (await this.link.send(this.msgFrame(stored))) this.advanceMine([stored.id], 'sent')
    return stored
  }

  // ---------- message actions ----------

  /** One of our own messages that still exists (only those can be edited or deleted for everyone). */
  private ownMessage(id: string): StoredMessage {
    const m = isUuid(id) ? this.db.getMessage(id) : undefined
    if (!m || m.ref || m.authorId !== this.selfId) throw new Error('Not your message')
    if (this.decorate([m])[0].deleted) throw new Error('Message was deleted')
    return m
  }

  async edit(id: string, text: string): Promise<void> {
    const m = this.ownMessage(id)
    const body = text.trim()
    if ((!body && !m.image && !m.file) || body.length > MAX_TEXT_LENGTH) throw new Error('Message is empty or too long')
    if (body === this.decorate([m])[0].text) return
    await this.sendEvent('edit', m.id, body)
  }

  /** Our own message, for both of us: its text and picture are erased on both computers. */
  async deleteForEveryone(id: string): Promise<void> {
    const m = this.ownMessage(id)
    await this.sendEvent('delete', m.id, null)
    this.erase(m.id)
    this.emit({ type: 'event', target: m.id })
  }

  /** Any message, on this computer only. */
  deleteForMe(id: string): void {
    const m = isUuid(id) ? this.db.getMessage(id) : undefined
    if (!m || m.ref) throw new Error('Message not found')
    // Not delivered yet: erasing it here would send an empty message later.
    if (m.authorId === this.selfId && (m.status === 'queued' || m.status === 'sent')) throw new Error('Not delivered yet — delete it for everyone instead')
    this.db.hide(m.id)
    this.store.remove(m.id)
    this.transfers.cancel(m.id)
    this.emit({ type: 'event', target: m.id })
  }

  /** Adds or removes one of our reactions (several per message are fine). */
  async react(id: string, emoji: string, on: boolean): Promise<void> {
    const m = isUuid(id) ? this.db.getMessage(id) : undefined
    if (!m || m.ref || !isReactionEmoji(emoji)) throw new Error('Invalid reaction')
    const view = this.decorate([m])[0]
    if (view.deleted) return
    if ((view.reactions ?? []).some((r) => r.emoji === emoji && r.mine) === on) return
    await this.sendEvent('react', m.id, reactionData(emoji, on))
  }

  private erase(id: string): void {
    this.db.wipe(id)
    this.store.remove(id)
    this.transfers.cancel(id)
  }

  // ---------- channels ----------
  // A channel is a label on the one message stream. Creating, renaming and deleting are ordinary
  // rows in the per-author sequence, so the queue, sync, backup and recovery carry them as is.

  /** Live channels (id → name), oldest first. Rebuilt only when one changes. */
  private channelCache: Map<string, string> | null = null

  private channelMap(): Map<string, string> {
    if (this.channelCache) return this.channelCache
    const ops = this.db.channelOps().sort((a, b) => a.sentAt - b.sentAt || (a.id < b.id ? -1 : 1))
    const gone = new Set(ops.filter((o) => o.kind === 'channel-del').map((o) => o.ref!))
    const out = new Map<string, string>()
    // Both computers hold the same rows, so "last one wins" comes out the same on both.
    for (const o of ops) if (o.kind === 'channel' && !gone.has(o.ref!)) out.set(o.ref!, cleanChannelName(o.data) ?? 'Unnamed')
    this.channelCache = out
    return out
  }

  listChannels(): ChannelInfo[] {
    const muted = this.mutedChannels()
    return [[GENERAL_CHANNEL, 'General'] as const, ...this.channelMap()].map(([id, name]) => ({ id, name, ...(muted.has(id) ? { muted: true } : {}) }))
  }

  /** Mutes are this computer's own preference: the other person is never told. */
  private mutedChannels(): Set<string> {
    return new Set(this.db.getSetting<string[]>(MUTED_CHANNELS) ?? [])
  }

  isMuted(channel: string): boolean {
    return this.mutedChannels().has(channel)
  }

  private storeMute(id: string, on: boolean): void {
    const muted = this.mutedChannels()
    if (on) muted.add(id)
    else muted.delete(id)
    this.db.setSetting(MUTED_CHANNELS, [...muted])
  }

  setChannelMuted(id: string, on: boolean): void {
    if (id !== GENERAL_CHANNEL && !this.channelMap().has(id)) throw new Error('That channel is gone')
    this.storeMute(id, on)
    this.emit({ type: 'channels', channels: this.listChannels() })
  }

  private channelsChanged(erased?: string): void {
    this.channelCache = null
    this.searchText = null // rebuilt on the next search, with the right channels
    this.emit({ type: 'channels', channels: this.listChannels(), ...(erased ? { erased } : {}) })
  }

  private checkChannelName(name: string, except?: string): string {
    const clean = cleanChannelName(name)
    if (!clean) throw new Error('Channel names can be 1 to 32 characters')
    const key = clean.toLocaleLowerCase()
    if (this.listChannels().some((c) => c.id !== except && c.name.toLocaleLowerCase() === key)) throw new Error('There is already a channel with that name')
    return clean
  }

  /** Whether channels can be used yet (the other Hush must support them too). */
  private assertChannelsUsable(): void {
    this.assertCanWrite()
    if (!this.channelsReady()) throw new Error('Channels need both computers on the latest Hush')
  }

  async createChannel(name: string): Promise<ChannelInfo> {
    this.assertChannelsUsable()
    const clean = this.checkChannelName(name)
    if (this.channelMap().size >= MAX_CHANNELS) throw new Error(`You can have up to ${MAX_CHANNELS} channels`)
    const id = randomUUID()
    await this.sendChannelRow(id, clean)
    return { id, name: clean }
  }

  async renameChannel(id: string, name: string): Promise<void> {
    this.assertChannelsUsable()
    if (!this.channelMap().has(id)) throw new Error('That channel is gone')
    const clean = this.checkChannelName(name, id)
    if (clean !== this.channelMap().get(id)) await this.sendChannelRow(id, clean)
  }

  private writeChannelRow(id: string, name: string): StoredMessage {
    return this.db.createOwnMessage(this.selfId, '', Date.now(), null, undefined, { kind: 'channel', ref: id, data: name }, null, null, id)
  }

  private async sendChannelRow(id: string, name: string): Promise<void> {
    const stored = this.writeChannelRow(id, name)
    this.channelsChanged()
    if (await this.link.send(this.msgFrame(stored))) this.advanceMine([stored.id], 'sent')
  }

  /** Permanently erases a channel and everything in it, on both computers. */
  async deleteChannel(id: string): Promise<void> {
    this.assertChannelsUsable()
    if (!this.channelMap().has(id)) throw new Error('That channel is gone')
    let stored: StoredMessage
    this.eraseChannel(id, () => {
      stored = this.db.createOwnMessage(this.selfId, '', Date.now(), null, undefined, { kind: 'channel-del', ref: id, data: null }, null, null, id)
      return true
    })
    if (await this.link.send(this.msgFrame(stored!))) this.advanceMine([stored!.id], 'sent')
  }

  /**
   * Records a delete and erases the channel as one step. `record` returns false for a delete
   * already applied. Crashing halfway rolls back, and the delete is simply delivered again.
   */
  private eraseChannel(id: string, record: () => boolean): void {
    const erased = this.db.atomic(() => {
      if (!record()) return null
      const files = this.db.channelAttachmentIds(id)
      for (const f of files) this.store.remove(f)
      return { files, rows: this.db.eraseChannel(id) }
    })
    if (!erased) return
    this.transfers.cancelMany(erased.files)
    for (const r of erased.rows) this.flushWatch.delete(r)
    this.storeMute(id, false)
    this.db.checkpoint()
    this.channelsChanged(id)
  }

  /** Unread messages per channel, and in total. Messages in a channel not known yet don't count. */
  unread(): { total: number; byChannel: Record<string, number> } {
    const known = this.channelMap()
    const byChannel: Record<string, number> = {}
    let total = 0
    for (const { channel, n } of this.db.unreadByChannel(this.selfId)) {
      if (channel !== GENERAL_CHANNEL && !known.has(channel)) continue
      byChannel[channel] = n
      total += n
    }
    return { total, byChannel }
  }

  private toChat(m: StoredMessage): ChatMessage {
    return this.decorate([m])[0]
  }

  /** Messages for the UI with edits, deletions, reactions and reply previews applied. */
  private decorate(rows: StoredMessage[]): ChatMessage[] {
    if (rows.length === 0) return []
    const replyIds = [...new Set(rows.map((r) => r.replyTo).filter((x): x is string => !!x))]
    const targets = this.db.getMessages(replyIds)
    const events = new Map<string, StoredMessage[]>()
    for (const e of this.db.eventsFor([...rows.map((r) => r.id), ...targets.map((t) => t.id)])) {
      const list = events.get(e.ref!) ?? []
      list.push(e)
      events.set(e.ref!, list)
    }
    const view = (m: StoredMessage): ChatMessage => {
      const msg = toChatMessage(m, this.selfId, (id) => this.store.hasFull(id, blobOf(m)))
      if (this.transfers.isStopped(m.id)) {
        if (msg.image) msg.image.stopped = true
        if (msg.file) msg.file.stopped = true
      }
      if (msg.unsupported) return msg
      const state = applyEvents(m.authorId, events.get(m.id) ?? [], this.selfId)
      if (state.deleted || msg.deleted) {
        delete msg.image
        return { ...msg, text: '', deleted: true }
      }
      if (state.text !== undefined) {
        msg.text = state.text
        msg.editedAt = state.editedAt
      }
      if (state.reactions.length > 0) msg.reactions = state.reactions
      return msg
    }
    const quoted = new Map(targets.map((t) => [t.id, view(t)]))
    return rows.map((m) => {
      const msg = view(m)
      if (m.replyTo && !msg.deleted) {
        const t = quoted.get(m.replyTo)
        msg.replyTo = t
          ? { id: t.id, missing: false, from: t.from, text: t.text.slice(0, 200), hasImage: !!t.image, deleted: !!t.deleted }
          : { id: m.replyTo, missing: true }
      }
      return msg
    })
  }

  private queueAck(id: string): void {
    this.ackQueue.push(id)
    if (this.ackTimer) return
    this.ackTimer = setTimeout(() => {
      this.ackTimer = undefined
      const ids = [...new Set(this.ackQueue.splice(0))]
      for (let i = 0; i < ids.length; i += 500) void this.link.send({ t: 'ack', ids: ids.slice(i, i + 500) })
    }, ACK_BATCH_MS)
  }

  private advanceMine(ids: string[], status: 'sent' | 'delivered' | 'read'): void {
    this.applyChanges(this.db.advanceStatus(ids, status, this.selfId), status)
  }

  private applyChanges(changed: string[], status: 'sent' | 'delivered' | 'read'): void {
    if (changed.length === 0) return
    this.emit({ type: 'status', updates: changed.map((id) => ({ id, status })) })
    if (status === 'sent') return
    for (const id of changed) {
      if (this.flushWatch.delete(id)) this.flushCount++
    }
    if (this.flushCount > 0) {
      clearTimeout(this.flushTimer)
      this.flushTimer = setTimeout(() => {
        if (this.flushCount === 0) return
        this.emit({ type: 'flushed', count: this.flushCount, at: Date.now() })
        this.flushCount = 0
      }, FLUSH_QUIET_MS)
    }
  }

  private rememberPeer(peer: LinkPeer): void {
    // The other app came back with a new device id (reinstalled): remember the old one, so it
    // can take its history back (askPreviousId on its side).
    const before = this.db.getSetting<string>('peerId')
    if (before && before !== peer.id && this.db.maxSeq(before) > 0) this.db.setSetting('previousPeerId', before)
    if (this.db.getSetting<string>('previousPeerId') === peer.id) this.db.setSetting('previousPeerId', null)
    // Read fresh on every connection, so a peer going back to an older Hush is noticed.
    const channels = peer.features.includes('channels')
    this.db.setSetting('peerChannels', channels)
    // A reinstalled peer can't get back rows written under its old id, so the channels it created
    // would be unknown to it. Re-announcing them under our id goes out with the coming sync.
    if (before && before !== peer.id && channels && !this.db.getSetting<boolean>(AWAITING_SYNC)) {
      for (const [id, name] of this.channelMap()) this.writeChannelRow(id, name)
      this.channelCache = null
    }
    this.db.setSetting('peerId', peer.id)
    this.db.setSetting('peerName', peer.name)
    this.db.setSetting('peerApp', peer.app)
    this.db.setSetting('peerLastSeen', Date.now())
  }
}

/** General is the absence of a channel id on the wire. */
const channelField = (channel: string): { channel?: string } => (channel === GENERAL_CHANNEL ? {} : { channel })

interface SearchEntry extends SearchResult {
  folded: string
}
