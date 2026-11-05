import { randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'
import type { ImageMeta } from '../shared/protocol'
import { CALL_OUTCOMES, type CallRecord, type ChatImage, type ChatMessage, type HistoryCursor, type MessageStatus } from '../shared/types'
import { isUuid } from '../shared/protocol'
import { isSealedField, plainFields, type FieldCipher } from './vault'

/**
 * A message as stored. `authorId` is a stable install id, not "me"/"peer".
 * `seq` is the author's own counter (1, 2, 3…); null only for messages received before
 * sequence numbers existed (stage b) until the next sync fills it in.
 */
export interface StoredMessage {
  id: string
  authorId: string
  seq: number | null
  body: string
  sentAt: number
  status: MessageStatus
  /** Present for image messages; the files live in the image store, named by message id. */
  image: ImageMeta | null
  /** 'message' (default) or an event kind ('edit', 'delete', 'react', or newer ones). */
  kind?: string
  /** The message an event acts on. Events always have one; chat messages never do. */
  ref?: string | null
  /** Event payload (e.g. new text, emoji). */
  data?: string | null
  /** The message this one answers (chat messages only). */
  replyTo?: string | null
}

type Migration = (db: Database.Database) => void

const MIGRATIONS: Migration[] = [
  // v1 — stage b
  (db) =>
    db.exec(`
      CREATE TABLE messages (
        id          TEXT PRIMARY KEY,
        author_id   TEXT NOT NULL,
        body        TEXT NOT NULL,
        sent_at     INTEGER NOT NULL,
        received_at INTEGER NOT NULL,
        status      TEXT NOT NULL CHECK (status IN ('queued','sent','delivered','read'))
      );
      CREATE INDEX messages_by_time ON messages (sent_at, id);
      CREATE TABLE settings (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );`),

  // v2 — stage c: per-author sequence numbers for sync.
  // Only this install's own messages are numbered here (it is the authority for them);
  // the other person's messages get their numbers from them during the next sync.
  // Numbering both sides locally could disagree and wrongly mark a message as delivered.
  (db) => {
    db.exec(`
      ALTER TABLE messages ADD COLUMN seq INTEGER;
      CREATE UNIQUE INDEX messages_by_author_seq ON messages (author_id, seq) WHERE seq IS NOT NULL;`)
    const self = db.prepare(`SELECT value FROM settings WHERE key = 'selfId'`).get() as { value: string } | undefined
    if (self) {
      db.prepare(
        `UPDATE messages SET seq = (
           SELECT n FROM (
             SELECT id, ROW_NUMBER() OVER (ORDER BY sent_at, id) AS n FROM messages WHERE author_id = ?
           ) numbered WHERE numbered.id = messages.id)
         WHERE author_id = ?`
      ).run(JSON.parse(self.value), JSON.parse(self.value))
    }
  },

  // v3 — stage d: image metadata (JSON); the image files themselves are stored on disk.
  (db) => db.exec(`ALTER TABLE messages ADD COLUMN image TEXT;`),

  // v4 — call history (each computer keeps its own view of each call).
  (db) =>
    db.exec(`
      CREATE TABLE calls (
        id           TEXT PRIMARY KEY,
        direction    TEXT NOT NULL CHECK (direction IN ('in','out')),
        started_at   INTEGER NOT NULL,
        connected_at INTEGER,
        ended_at     INTEGER,
        outcome      TEXT NOT NULL
      );
      CREATE INDEX calls_by_time ON calls (started_at);`),

  // v5 — events (edit / delete / react) live in the same per-author sequence as messages, so the
  // offline queue and sync carry them too. They point at a message via `ref`.
  (db) =>
    db.exec(`
      ALTER TABLE messages ADD COLUMN kind TEXT NOT NULL DEFAULT 'message';
      ALTER TABLE messages ADD COLUMN ref TEXT;
      ALTER TABLE messages ADD COLUMN data TEXT;
      CREATE INDEX messages_by_ref ON messages (ref) WHERE ref IS NOT NULL;`),

  // v6 — replies, and "delete for me" (hidden here only; never synced).
  (db) =>
    db.exec(`
      ALTER TABLE messages ADD COLUMN reply_to TEXT;
      ALTER TABLE messages ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0;`)
]

// Status only ever moves forward, so replayed or out-of-order receipts are harmless.
const RANK = `CASE status WHEN 'queued' THEN 0 WHEN 'sent' THEN 1 WHEN 'delivered' THEN 2 WHEN 'read' THEN 3 END`
const RANK_OF: Record<MessageStatus, number> = { queued: 0, sent: 1, delivered: 2, read: 3 }
const COLUMNS = 'id, author_id, seq, body, sent_at, status, image, kind, ref, data, reply_to'

interface Row {
  id: string
  author_id: string
  seq: number | null
  body: string
  sent_at: number
  status: MessageStatus
  image: string | null
  kind: string
  ref: string | null
  data: string | null
  reply_to: string | null
}

export class HushDb {
  private db: Database.Database

  /** `cipher` encrypts message text and event data at rest (plain only in tests). */
  constructor(
    file: string,
    private readonly cipher: FieldCipher = plainFields
  ) {
    this.db = new Database(file)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('foreign_keys = ON')
    // Deleted rows are overwritten, so removed text doesn't linger in free pages.
    this.db.pragma('secure_delete = ON')
    this.migrate()
    // A call still "ongoing" means Hush quit mid-call; close it off.
    this.db.exec(`UPDATE calls SET outcome = CASE WHEN connected_at IS NOT NULL THEN 'completed' ELSE 'failed' END WHERE outcome = 'ongoing'`)
  }

  /** A consistent copy of the database (for backups), safe while Hush keeps running. */
  async snapshot(path: string): Promise<void> {
    await this.db.backup(path)
  }

  close(): void {
    this.db.close()
  }

  /** Schema version, for tests. */
  get version(): number {
    return this.db.pragma('user_version', { simple: true }) as number
  }

  private migrate(): void {
    for (let v = this.version; v < MIGRATIONS.length; v++) {
      this.db.transaction(() => {
        MIGRATIONS[v](this.db)
        this.db.pragma(`user_version = ${v + 1}`)
      })()
    }
  }

  // ---------- settings (JSON values) ----------

  getSetting<T>(key: string): T | undefined {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined
    return row ? (JSON.parse(row.value) as T) : undefined
  }

  /** A setting that is encrypted at rest (e.g. the identity private key). */
  getSecret<T>(key: string): T | undefined {
    const sealed = this.getSetting<string | null>(key)
    return sealed == null ? undefined : (JSON.parse(this.cipher.open(sealed)) as T)
  }

  setSecret(key: string, value: unknown): void {
    this.setSetting(key, this.cipher.seal(JSON.stringify(value)))
  }

  /**
   * One-time upgrade after encryption was turned on: seals message text / event data and the
   * listed secret settings that are still stored in plain text. Returns how many rows changed.
   */
  encryptExisting(secretKeys: string[]): number {
    let n = 0
    this.db.transaction(() => {
      const rows = this.db.prepare(`SELECT id, body, data FROM messages`).all() as { id: string; body: string; data: string | null }[]
      const upd = this.db.prepare('UPDATE messages SET body = ?, data = ? WHERE id = ?')
      for (const r of rows) {
        const needBody = r.body !== '' && !isSealedField(r.body)
        const needData = r.data !== null && r.data !== '' && !isSealedField(r.data)
        if (!needBody && !needData) continue
        upd.run(needBody ? this.cipher.seal(r.body) : r.body, needData ? this.cipher.seal(r.data!) : r.data, r.id)
        n++
      }
      for (const key of secretKeys) {
        const v = this.getSetting<unknown>(key)
        if (v === undefined) continue
        if (typeof v === 'string' && isSealedField(v)) continue
        this.setSecret(key, v)
      }
    })()
    // Don't leave the old plain text behind in the write-ahead log or free pages.
    this.db.pragma('wal_checkpoint(TRUNCATE)')
    this.db.exec('VACUUM')
    return n
  }

  setSetting(key: string, value: unknown): void {
    this.db
      .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, JSON.stringify(value))
  }

  // ---------- messages ----------

  /** Creates a message authored on this computer, assigning the next sequence number. */
  createOwnMessage(
    authorId: string,
    body: string,
    sentAt: number,
    image: ImageMeta | null = null,
    id: string = randomUUID(),
    event: { kind: string; ref: string; data: string | null } | null = null,
    replyTo: string | null = null
  ): StoredMessage {
    return this.db.transaction(() => {
      const { top } = this.db.prepare('SELECT COALESCE(MAX(seq), 0) AS top FROM messages WHERE author_id = ?').get(authorId) as { top: number }
      // After recovering history from the peer, numbering continues after the old messages
      // even before they have all arrived.
      const next = Math.max(top, this.getSetting<number>(`seqFloor:${authorId}`) ?? 0) + 1
      const m: StoredMessage = { id, authorId, seq: next, body, sentAt, status: 'queued', image, replyTo, ...(event ?? {}) }
      this.insertMessage(m)
      return m
    })()
  }

  /**
   * Inserts a message unless its id already exists (so re-sends never duplicate).
   * If it exists without a sequence number (stage-b history), the number is filled in.
   * Returns true only if the message was new.
   */
  insertMessage(m: StoredMessage, receivedAt: number = Date.now()): boolean {
    const r = this.db
      .prepare(
        `INSERT INTO messages (id, author_id, seq, body, sent_at, received_at, status, image, kind, ref, data, reply_to)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`
      )
      .run(
        m.id,
        m.authorId,
        m.seq,
        this.cipher.seal(m.body),
        m.sentAt,
        receivedAt,
        m.status,
        m.image ? JSON.stringify(m.image) : null,
        m.kind ?? 'message',
        m.ref ?? null,
        m.data == null ? null : this.cipher.seal(m.data),
        m.replyTo ?? null
      )
    if (r.changes === 1) return true
    if (m.seq !== null) {
      this.db.prepare('UPDATE messages SET seq = ? WHERE id = ? AND author_id = ? AND seq IS NULL').run(m.seq, m.id, m.authorId)
    }
    return false
  }

  getMessage(id: string): StoredMessage | undefined {
    const row = this.db.prepare(`SELECT ${COLUMNS} FROM messages WHERE id = ?`).get(id) as Row | undefined
    return row && this.toStored(row)
  }

  /** Several messages by id (missing ones are left out); "deleted for me" ones only if asked. */
  getMessages(ids: readonly string[], includeHidden = false): StoredMessage[] {
    return this.inChunks(ids, (part, marks) =>
      this.db.prepare(`SELECT ${COLUMNS} FROM messages WHERE id IN (${marks})${includeHidden ? '' : ' AND hidden = 0'}`).all(...part) as Row[]
    ).map((r) => this.toStored(r))
  }

  /** Every visible chat message, and every edit / delete (to build the in-memory search). */
  searchSource(): { messages: StoredMessage[]; events: StoredMessage[] } {
    const messages = this.db.prepare(`SELECT ${COLUMNS} FROM messages WHERE ref IS NULL AND hidden = 0 AND kind = 'message'`).all() as Row[]
    const events = this.db.prepare(`SELECT ${COLUMNS} FROM messages WHERE kind IN ('edit', 'delete')`).all() as Row[]
    return { messages: messages.map((r) => this.toStored(r)), events: events.map((r) => this.toStored(r)) }
  }

  /** All events (edit / delete / react) acting on these messages. */
  eventsFor(ids: readonly string[]): StoredMessage[] {
    return this.inChunks(ids, (part, marks) =>
      this.db.prepare(`SELECT ${COLUMNS} FROM messages WHERE ref IN (${marks})`).all(...part) as Row[]
    ).map((r) => this.toStored(r))
  }

  private inChunks(ids: readonly string[], query: (part: string[], marks: string) => Row[]): Row[] {
    const out: Row[] = []
    for (let i = 0; i < ids.length; i += 500) {
      const part = ids.slice(i, i + 500)
      out.push(...query(part, part.map(() => '?').join(',')))
    }
    return out
  }

  /**
   * Erases a message's content for good (deleted for everyone, or for me): its text, its picture
   * metadata, and the text of any edits. The row stays, so sequence numbers and sync still work.
   */
  wipe(id: string): void {
    this.db.transaction(() => {
      this.db.prepare(`UPDATE messages SET body = '', image = NULL WHERE id = ?`).run(id)
      this.db.prepare(`UPDATE messages SET data = '' WHERE ref = ? AND kind = 'edit'`).run(id)
    })()
  }

  /** "Delete for me": hidden on this computer only, and its content erased here. */
  hide(id: string): void {
    this.wipe(id)
    this.db.prepare('UPDATE messages SET hidden = 1 WHERE id = ?').run(id)
  }

  /**
   * Advances the status of the given messages (never moves backwards).
   * Restricted to messages by `authorId` so a peer can't alter the other side's records.
   * Returns the ids that actually changed.
   */
  advanceStatus(ids: readonly string[], status: MessageStatus, authorId: string): string[] {
    return this.advanceEach(ids, status, `author_id = ?`, authorId)
  }

  /**
   * Advances the status of incoming messages (anyone but `selfId`), e.g. marking them read.
   * Not tied to one peer id, so history from before a reinstall on their side still works.
   */
  advanceStatusFromOthers(ids: readonly string[], status: MessageStatus, selfId: string): string[] {
    return this.advanceEach(ids, status, `author_id <> ?`, selfId)
  }

  private advanceEach(ids: readonly string[], status: MessageStatus, authorClause: string, authorArg: string): string[] {
    if (ids.length === 0) return []
    const stmt = this.db.prepare(
      `UPDATE messages SET status = ? WHERE id = ? AND ${authorClause} AND ${RANK} < ? RETURNING id`
    )
    const changed: string[] = []
    this.db.transaction(() => {
      for (const id of ids) {
        const row = stmt.get(status, id, authorArg, RANK_OF[status]) as { id: string } | undefined
        if (row) changed.push(row.id)
      }
    })()
    return changed
  }

  /** Advances every message by `authorId` with seq ≤ upTo (sync watermarks). Returns changed ids. */
  advanceUpTo(authorId: string, upTo: number, status: MessageStatus): string[] {
    if (upTo <= 0) return []
    const rows = this.db
      .prepare(
        `UPDATE messages SET status = ? WHERE author_id = ? AND seq IS NOT NULL AND seq <= ? AND ${RANK} < ? RETURNING id`
      )
      .all(status, authorId, upTo, RANK_OF[status]) as { id: string }[]
    return rows.map((r) => r.id)
  }

  /**
   * Highest N such that messages 1…N by this author are all stored here.
   * "Contiguous" matters: a gap means something is missing and must be re-sent.
   */
  contiguousSeq(authorId: string): number {
    const hasFirst = this.db.prepare('SELECT 1 FROM messages WHERE author_id = ? AND seq = 1').get(authorId)
    if (!hasFirst) return 0
    const row = this.db
      .prepare(
        `SELECT MIN(m.seq) AS end FROM messages m
         WHERE m.author_id = ? AND m.seq IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM messages n WHERE n.author_id = m.author_id AND n.seq = m.seq + 1)`
      )
      .get(authorId) as { end: number }
    return row.end
  }

  /** Highest sequence number among this author's messages that are marked read here. */
  readSeq(authorId: string): number {
    const row = this.db
      .prepare(`SELECT COALESCE(MAX(seq), 0) AS r FROM messages WHERE author_id = ? AND status = 'read' AND seq IS NOT NULL`)
      .get(authorId) as { r: number }
    return row.r
  }

  /** This author's messages with seq > afterSeq, oldest first. */
  /** Highest sequence number stored for an author (0 if none). */
  maxSeq(authorId: string): number {
    return (this.db.prepare('SELECT COALESCE(MAX(seq), 0) AS top FROM messages WHERE author_id = ?').get(authorId) as { top: number }).top
  }

  messagesAfter(authorId: string, afterSeq: number, limit: number): StoredMessage[] {
    const rows = this.db
      .prepare(`SELECT ${COLUMNS} FROM messages WHERE author_id = ? AND seq > ? ORDER BY seq LIMIT ?`)
      .all(authorId, afterSeq, limit) as Row[]
    return rows.map((r) => this.toStored(r))
  }

  /** Ids of this author's messages currently in one of the given statuses. */
  idsWithStatus(authorId: string, statuses: MessageStatus[]): string[] {
    const rows = this.db
      .prepare(`SELECT id FROM messages WHERE author_id = ? AND status IN (${statuses.map(() => '?').join(',')})`)
      .all(authorId, ...statuses) as { id: string }[]
    return rows.map((r) => r.id)
  }

  /** Messages from the other person not yet seen on this computer. */
  unreadCount(selfId: string): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE author_id <> ? AND status <> 'read' AND ref IS NULL AND hidden = 0`).get(selfId) as { n: number }
    return row.n
  }

  // ---------- call history ----------

  /** Inserts or updates a call record (validated: it comes from the UI). */
  logCall(r: CallRecord): void {
    const ok =
      isUuid(r.id) &&
      (r.direction === 'in' || r.direction === 'out') &&
      Number.isSafeInteger(r.startedAt) &&
      [r.connectedAt, r.endedAt].every((t) => t === null || Number.isSafeInteger(t)) &&
      CALL_OUTCOMES.includes(r.outcome)
    if (!ok) throw new Error('Invalid call record')
    this.db
      .prepare(
        `INSERT INTO calls (id, direction, started_at, connected_at, ended_at, outcome) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET connected_at = excluded.connected_at, ended_at = excluded.ended_at, outcome = excluded.outcome`
      )
      .run(r.id.toLowerCase(), r.direction, r.startedAt, r.connectedAt, r.endedAt, r.outcome)
  }

  listCalls(): CallRecord[] {
    const rows = this.db.prepare('SELECT * FROM calls ORDER BY started_at').all() as {
      id: string
      direction: 'in' | 'out'
      started_at: number
      connected_at: number | null
      ended_at: number | null
      outcome: CallRecord['outcome']
    }[]
    return rows.map((r) => ({
      id: r.id,
      direction: r.direction,
      startedAt: r.started_at,
      connectedAt: r.connected_at,
      endedAt: r.ended_at,
      outcome: r.outcome
    }))
  }

  /** Image messages written by anyone but `selfId` (candidates for downloading). */
  imageMessages(): { id: string; image: ImageMeta }[] {
    const rows = this.db
      .prepare(`SELECT id, image FROM messages WHERE image IS NOT NULL ORDER BY sent_at`)
      .all() as { id: string; image: string }[]
    return rows.map((r) => ({ id: r.id, image: JSON.parse(r.image) as ImageMeta }))
  }

  private toStored(r: Row): StoredMessage {
    return toStored(r, (v) => this.cipher.open(v))
  }

  /** Newest-last page of history, older than `before` when given. */
  listMessages(before: HistoryCursor | undefined, limit: number): { rows: StoredMessage[]; hasMore: boolean } {
    const rows = (
      before
        ? this.db
            .prepare(
              `SELECT ${COLUMNS} FROM messages
               WHERE ref IS NULL AND hidden = 0 AND (sent_at < ? OR (sent_at = ? AND id < ?))
               ORDER BY sent_at DESC, id DESC LIMIT ?`
            )
            .all(before.sentAt, before.sentAt, before.id, limit + 1)
        : this.db.prepare(`SELECT ${COLUMNS} FROM messages WHERE ref IS NULL AND hidden = 0 ORDER BY sent_at DESC, id DESC LIMIT ?`).all(limit + 1)
    ) as Row[]
    const hasMore = rows.length > limit
    return { rows: rows.slice(0, limit).reverse().map((r) => this.toStored(r)), hasMore }
  }
}

function toStored(r: Row, open: (s: string) => string): StoredMessage {
  return {
    id: r.id,
    authorId: r.author_id,
    seq: r.seq,
    body: open(r.body),
    sentAt: r.sent_at,
    status: r.status,
    image: r.image ? (JSON.parse(r.image) as ImageMeta) : null,
    kind: r.kind,
    ref: r.ref,
    data: r.data === null ? null : open(r.data),
    replyTo: r.reply_to
  }
}

/**
 * Converts a stored message for the UI, from this install's point of view.
 * `imageReady` reports whether the full image file is on this computer.
 */
export function toChatMessage(m: StoredMessage, selfId: string, imageReady: (id: string) => boolean = () => false): ChatMessage {
  const msg: ChatMessage = { id: m.id, from: m.authorId === selfId ? 'me' : 'peer', text: m.body, sentAt: m.sentAt, status: m.status }
  if (m.image) msg.image = chatImage(m.id, m.image, imageReady(m.id))
  // A standalone message kind from a newer Hush: show a placeholder instead of breaking.
  if (m.kind && m.kind !== 'message') {
    msg.text = ''
    msg.unsupported = true
  } else if (m.body === '' && !m.image) {
    msg.deleted = true // its content was wiped
  }
  return msg
}

export function chatImage(id: string, meta: ImageMeta, ready: boolean): ChatImage {
  const key = id.toLowerCase()
  return {
    width: meta.width,
    height: meta.height,
    mime: meta.mime,
    size: meta.size,
    thumbUrl: `hush-img://${key}/thumb`,
    fullUrl: `hush-img://${key}/full`,
    ready
  }
}
