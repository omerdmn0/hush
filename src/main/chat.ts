import { randomUUID } from 'node:crypto'
import { IMAGE_MIME, MAX_IMAGE_BYTES, MAX_TEXT_LENGTH, sniffImage, type Frame, type ImageMeta, type ImageMime } from '../shared/protocol'
import type { ChatMessage, HistoryCursor, HushEvent, OutgoingImage, PeerState } from '../shared/types'
import { toChatMessage, type HushDb, type StoredMessage } from './db'
import { sha256, type ImageStore } from './images'
import type { LinkPeer, PeerLink } from './link'
import type { Avatars } from './avatars'
import { Transfers } from './transfers'

/** Messages re-sent per database page during sync. */
const SYNC_PAGE = 200
/** Incoming messages are acknowledged in one batch after this short pause. */
const ACK_BATCH_MS = 50
/** "N queued messages delivered" is reported once deliveries go quiet for this long. */
const FLUSH_QUIET_MS = 600
/** Inline previews larger than this are refused (they must fit in one frame as base64). */
const MAX_THUMB_BYTES = 150 * 1024
const PREVIEW_TYPES = new Set<string>(['image/webp', 'image/jpeg', 'image/png'])

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

  constructor(
    private readonly db: HushDb,
    private readonly link: PeerLink,
    private readonly selfId: string,
    private readonly emit: (e: HushEvent) => void,
    private readonly store: ImageStore,
    opts: { chunkBytes?: number; avatars?: Avatars } = {}
  ) {
    this.avatars = opts.avatars ?? null
    this.transfers = new Transfers(db, store, link, selfId, emit, opts.chunkBytes)
    link.on('up', (peer) => this.onUp(peer))
    link.on('down', () => this.onDown())
    link.on('frame', (frame, peer) => void this.onFrame(frame, peer))
  }

  peerState(): PeerState {
    return {
      name: this.db.getSetting<string>('peerName') ?? null,
      presence: this.link.peer ? 'online' : 'offline',
      lastSeen: this.db.getSetting<number>('peerLastSeen') ?? null
    }
  }

  listMessages(before: HistoryCursor | undefined, limit: number): { messages: ChatMessage[]; hasMore: boolean } {
    const { rows, hasMore } = this.db.listMessages(before, Math.min(Math.max(limit, 1), 500))
    return { messages: rows.map((m) => this.toChat(m)), hasMore }
  }

  /** Validates an image prepared by the UI, stores it, and sends it like a message. */
  async sendImage(img: OutgoingImage, caption: string): Promise<ChatMessage> {
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
    const stored = this.db.createOwnMessage(this.selfId, body, Date.now(), meta, id)
    this.emit({ type: 'message', message: this.toChat(stored) })
    const ok = await this.link.send(this.msgFrame(stored))
    if (ok) this.advanceMine([stored.id], 'sent')
    return this.toChat(this.db.getMessage(stored.id)!)
  }

  async send(text: string): Promise<ChatMessage> {
    const body = text.trim()
    if (!body || body.length > MAX_TEXT_LENGTH) throw new Error('Message is empty or too long')
    const stored = this.db.createOwnMessage(this.selfId, body, Date.now())
    this.emit({ type: 'message', message: this.toChat(stored) })

    // Offline: stays queued and goes out with the next sync.
    const ok = await this.link.send(this.msgFrame(stored))
    if (ok) this.advanceMine([stored.id], 'sent')
    return this.toChat(this.db.getMessage(stored.id)!)
  }

  /** The user has seen these incoming messages. */
  markRead(ids: string[]): void {
    const changed = this.db.advanceStatusFromOthers(ids, 'read', this.selfId)
    if (changed.length === 0) return
    this.emit({ type: 'status', updates: changed.map((id) => ({ id, status: 'read' })) })
    const peerId = this.link.peer?.id
    // Offline: the watermark travels in the next sync frame instead.
    if (peerId) void this.link.send({ t: 'read', author: peerId, upTo: this.db.readSeq(peerId) })
  }

  setTyping(on: boolean): void {
    void this.link.send({ t: 'typing', on })
  }

  // ---------- link events ----------

  /** New active connection (also after a duplicate-connection switch): re-sync. Idempotent. */
  private onUp(peer: LinkPeer): void {
    this.rememberPeer(peer)
    for (const id of this.db.idsWithStatus(this.selfId, ['queued'])) this.flushWatch.add(id)
    this.emit({ type: 'peer', peer: this.peerState() })
    void this.link.send({
      t: 'sync',
      have: { [this.selfId]: this.db.contiguousSeq(this.selfId), [peer.id]: this.db.contiguousSeq(peer.id) },
      read: { [peer.id]: this.db.readSeq(peer.id) }
    })
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
        // On a direct link the author must be the connected peer.
        if (frame.author !== peer.id) return
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
          image
        }
        if (this.db.insertMessage(stored)) {
          this.emit({ type: 'typing', on: false })
          this.emit({ type: 'message', message: this.toChat(stored) })
          if (image) this.transfers.want(stored.id)
        }
        // Always ack, even duplicates — the sender may have missed the first ack.
        this.queueAck(frame.id)
        break
      }
      case 'sync':
        await this.onSync(frame)
        break
      case 'blob-req':
      case 'blob-err':
        this.transfers.onFrame(frame)
        break
      case 'ack':
        this.advanceMine(frame.ids, 'delivered')
        break
      case 'read':
        if (frame.author === this.selfId) this.applyChanges(this.db.advanceUpTo(this.selfId, frame.upTo, 'read'), 'read')
        break
      case 'typing':
        this.emit({ type: 'typing', on: frame.on })
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

  /** The peer told us what it holds and has read; catch up statuses and send what it lacks. */
  private async onSync(frame: Extract<Frame, { t: 'sync' }>): Promise<void> {
    const theyHave = frame.have[this.selfId] ?? 0
    this.applyChanges(this.db.advanceUpTo(this.selfId, theyHave, 'delivered'), 'delivered')
    this.applyChanges(this.db.advanceUpTo(this.selfId, frame.read[this.selfId] ?? 0, 'read'), 'read')

    let after = theyHave
    for (;;) {
      const page = this.db.messagesAfter(this.selfId, after, SYNC_PAGE)
      if (page.length === 0) break
      for (const m of page) {
        if (!(await this.link.send(this.msgFrame(m)))) return // connection dropped; next sync resumes
        this.advanceMine([m.id], 'sent')
        after = m.seq!
      }
    }
  }

  // ---------- helpers ----------

  private msgFrame(m: StoredMessage): Frame {
    const frame: Frame = { t: 'msg', id: m.id, author: this.selfId, seq: m.seq!, body: m.body, sentAt: m.sentAt }
    return m.image ? { ...frame, image: { ...m.image, thumb: this.store.readThumbBase64(m.id) } } : frame
  }

  private toChat(m: StoredMessage): ChatMessage {
    return toChatMessage(m, this.selfId, (id) => this.store.hasFull(id, m.image))
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
    this.db.setSetting('peerId', peer.id)
    this.db.setSetting('peerName', peer.name)
    this.db.setSetting('peerLastSeen', Date.now())
  }
}
