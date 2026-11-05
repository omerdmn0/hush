import { randomUUID } from 'node:crypto'
import { chunkIds, MAX_TEXT_LENGTH, type Frame } from '../shared/protocol'
import type { ChatMessage, HistoryCursor, HushEvent, PeerState } from '../shared/types'
import { toChatMessage, type HushDb } from './db'
import type { LinkPeer, PeerLink } from './link'

/**
 * Chat logic on top of a PeerLink: stores messages, sends receipts, tracks presence.
 * Every handler is idempotent (UUID keys, forward-only status), which is what makes the
 * offline queue / history sync in stage c — and a later relay node — safe to add.
 */
export class ChatService {
  constructor(
    private readonly db: HushDb,
    private readonly link: PeerLink,
    private readonly selfId: string,
    private readonly emit: (e: HushEvent) => void
  ) {
    link.on('up', (peer) => this.onUp(peer))
    link.on('down', () => this.onDown())
    link.on('frame', (frame, peer) => this.onFrame(frame, peer))
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
    return { messages: rows.map((m) => toChatMessage(m, this.selfId)), hasMore }
  }

  async send(text: string): Promise<ChatMessage> {
    const body = text.trim()
    if (!body || body.length > MAX_TEXT_LENGTH) throw new Error('Message is empty or too long')
    const stored = { id: randomUUID(), authorId: this.selfId, body, sentAt: Date.now(), status: 'queued' as const }
    this.db.insertMessage(stored)
    this.emit({ type: 'message', message: toChatMessage(stored, this.selfId) })

    // Offline: stays queued. Delivering the queue on reconnect is stage c.
    const ok = await this.link.send({ t: 'msg', id: stored.id, author: this.selfId, body, sentAt: stored.sentAt })
    if (ok) this.advanceMine([stored.id], 'sent')
    return toChatMessage(this.db.getMessage(stored.id)!, this.selfId)
  }

  /** The user has seen these incoming messages. */
  markRead(ids: string[]): void {
    const changed = this.db.advanceStatusFromOthers(ids, 'read', this.selfId)
    if (changed.length === 0) return
    this.emit({ type: 'status', updates: changed.map((id) => ({ id, status: 'read' })) })
    for (const chunk of chunkIds(changed)) void this.link.send({ t: 'read', ids: chunk })
  }

  setTyping(on: boolean): void {
    void this.link.send({ t: 'typing', on })
  }

  // ---------- link events ----------

  private onUp(peer: LinkPeer): void {
    this.rememberPeer(peer)
    this.emit({ type: 'peer', peer: this.peerState() })
  }

  private onDown(): void {
    this.db.setSetting('peerLastSeen', Date.now())
    this.emit({ type: 'typing', on: false })
    this.emit({ type: 'peer', peer: this.peerState() })
  }

  private onFrame(frame: Frame, peer: LinkPeer): void {
    switch (frame.t) {
      case 'msg': {
        // On a direct link the author must be the connected peer.
        if (frame.author !== peer.id) return
        const stored = { id: frame.id, authorId: frame.author, body: frame.body, sentAt: frame.sentAt, status: 'delivered' as const }
        if (this.db.insertMessage(stored)) {
          this.emit({ type: 'typing', on: false })
          this.emit({ type: 'message', message: toChatMessage(stored, this.selfId) })
        }
        // Always ack, even duplicates — the sender may have missed the first ack.
        void this.link.send({ t: 'ack', ids: [frame.id] })
        break
      }
      case 'ack':
        this.advanceMine(frame.ids, 'delivered')
        break
      case 'read':
        this.advanceMine(frame.ids, 'read')
        break
      case 'typing':
        this.emit({ type: 'typing', on: frame.on })
        break
      case 'profile':
        this.rememberPeer(peer)
        this.emit({ type: 'peer', peer: this.peerState() })
        break
      case 'hello':
        break
    }
  }

  private advanceMine(ids: string[], status: 'sent' | 'delivered' | 'read'): void {
    const changed = this.db.advanceStatus(ids, status, this.selfId)
    if (changed.length) this.emit({ type: 'status', updates: changed.map((id) => ({ id, status })) })
  }

  private rememberPeer(peer: LinkPeer): void {
    this.db.setSetting('peerId', peer.id)
    this.db.setSetting('peerName', peer.name)
    this.db.setSetting('peerLastSeen', Date.now())
  }
}
