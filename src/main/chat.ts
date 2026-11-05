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
/** Setting: a backup was restored and the peer hasn't synced with us since. */
export const AWAITING_SYNC = 'awaitingSync'

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
    this.transfers = new Transfers(db, store, link, emit, opts.chunkBytes)
    link.on('up', (peer) => this.onUp(peer))
    link.on('down', () => this.onDown())
    link.on('frame', (frame, peer) => void this.onFrame(frame, peer))
  }

  peerState(): PeerState {
    return {
      name: this.db.getSetting<string>('peerName') ?? null,
      presence: this.link.peer ? 'online' : 'offline',
      lastSeen: this.db.getSetting<number>('peerLastSeen') ?? null,
      appVersion: this.db.getSetting<string>('peerApp') ?? null,
      catchingUp: !!this.db.getSetting<boolean>(AWAITING_SYNC)
    }
  }

  /** After a restore, nothing new is written until the peer has told us what it holds. */
  private assertCanWrite(): void {
    if (this.db.getSetting<boolean>(AWAITING_SYNC)) throw new Error('Catching up with the other computer first')
  }

  listMessages(before: HistoryCursor | undefined, limit: number): { messages: ChatMessage[]; hasMore: boolean } {
    const { rows, hasMore } = this.db.listMessages(before, Math.min(Math.max(limit, 1), 500))
    return { messages: rows.map((m) => this.toChat(m)), hasMore }
  }

  /** Validates an image prepared by the UI, stores it, and sends it like a message. */
  async sendImage(img: OutgoingImage, caption: string): Promise<ChatMessage> {
    this.assertCanWrite()
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
    this.assertCanWrite()
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
        // On a direct link the author must be the connected peer — or us, when the peer sends
        // back our own messages after we recovered our history from it.
        const own = frame.author === this.selfId
        if (frame.author !== peer.id && !own) return
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
          data: frame.data ?? null
        }
        // Events (edit/delete/react) are stored and acked like messages; the UI applies them.
        if (this.db.insertMessage(stored)) {
          if (stored.ref) {
            this.emit({ type: 'event', target: stored.ref })
          } else {
            if (!own) this.emit({ type: 'typing', on: false })
            this.emit({ type: 'message', message: this.toChat(stored) })
            if (image) this.transfers.want(stored.id)
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

  /**
   * The peer told us what it holds and has read; catch up statuses and send what it lacks —
   * our messages, and its own ones it no longer has (after it recovered its history from us).
   */
  private async onSync(frame: Extract<Frame, { t: 'sync' }>, peer: LinkPeer): Promise<void> {
    const theyHave = frame.have[this.selfId] ?? 0
    // They hold more of our messages than we do (we restored an older backup): number new ones
    // after theirs — the missing ones come back below, through their own sync.
    const floorKey = `seqFloor:${this.selfId}`
    if (theyHave > Math.max(this.db.maxSeq(this.selfId), this.db.getSetting<number>(floorKey) ?? 0)) this.db.setSetting(floorKey, theyHave)
    if (this.db.getSetting<boolean>(AWAITING_SYNC)) {
      this.db.setSetting(AWAITING_SYNC, null)
      this.emit({ type: 'peer', peer: this.peerState() })
    }
    this.applyChanges(this.db.advanceUpTo(this.selfId, theyHave, 'delivered'), 'delivered')
    this.applyChanges(this.db.advanceUpTo(this.selfId, frame.read[this.selfId] ?? 0, 'read'), 'read')

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
        if (!(await this.link.send(this.msgFrame(m)))) return false // next sync resumes
        if (mine) this.advanceMine([m.id], 'sent')
        after = m.seq!
      }
    }
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

  private msgFrame(m: StoredMessage): Frame {
    const frame: Extract<Frame, { t: 'msg' }> = { t: 'msg', id: m.id, author: m.authorId, seq: m.seq!, body: m.body, sentAt: m.sentAt }
    if (m.image) frame.image = { ...m.image, thumb: this.store.readThumbBase64(m.id) }
    if (m.kind && m.kind !== 'message') frame.kind = m.kind
    if (m.ref) frame.ref = m.ref
    if (m.data != null) frame.data = m.data
    return frame
  }

  /**
   * Records an event (edit / delete / react) on message `ref` and sends it. Like messages, it
   * waits in the queue while the other app is offline and goes out with the next sync.
   */
  async sendEvent(kind: 'edit' | 'delete' | 'react', ref: string, data: string | null): Promise<StoredMessage> {
    this.assertCanWrite()
    const stored = this.db.createOwnMessage(this.selfId, '', Date.now(), null, undefined, { kind, ref, data })
    this.emit({ type: 'event', target: ref })
    if (await this.link.send(this.msgFrame(stored))) this.advanceMine([stored.id], 'sent')
    return stored
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
    // The other app came back with a new device id (reinstalled): remember the old one, so it
    // can take its history back (askPreviousId on its side).
    const before = this.db.getSetting<string>('peerId')
    if (before && before !== peer.id && this.db.maxSeq(before) > 0) this.db.setSetting('previousPeerId', before)
    if (this.db.getSetting<string>('previousPeerId') === peer.id) this.db.setSetting('previousPeerId', null)
    this.db.setSetting('peerId', peer.id)
    this.db.setSetting('peerName', peer.name)
    this.db.setSetting('peerApp', peer.app)
    this.db.setSetting('peerLastSeen', Date.now())
  }
}
