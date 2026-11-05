import Database from 'better-sqlite3'
import type { ChatMessage, HistoryCursor, MessageStatus } from '../shared/types'

/** A message as stored: author is a stable install id, not "me"/"peer". */
export interface StoredMessage {
  id: string
  authorId: string
  body: string
  sentAt: number
  status: MessageStatus
}

const MIGRATIONS: string[] = [
  // v1
  `CREATE TABLE messages (
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
   );`
]

// Status only ever moves forward, so replayed or out-of-order receipts are harmless.
const RANK = `CASE status WHEN 'queued' THEN 0 WHEN 'sent' THEN 1 WHEN 'delivered' THEN 2 WHEN 'read' THEN 3 END`
const RANK_OF: Record<MessageStatus, number> = { queued: 0, sent: 1, delivered: 2, read: 3 }

interface Row {
  id: string
  author_id: string
  body: string
  sent_at: number
  status: MessageStatus
}

export class HushDb {
  private db: Database.Database

  constructor(file: string) {
    this.db = new Database(file)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('foreign_keys = ON')
    this.migrate()
  }

  close(): void {
    this.db.close()
  }

  private migrate(): void {
    const current = this.db.pragma('user_version', { simple: true }) as number
    for (let v = current; v < MIGRATIONS.length; v++) {
      this.db.transaction(() => {
        this.db.exec(MIGRATIONS[v])
        this.db.pragma(`user_version = ${v + 1}`)
      })()
    }
  }

  // ---------- settings (JSON values) ----------

  getSetting<T>(key: string): T | undefined {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined
    return row ? (JSON.parse(row.value) as T) : undefined
  }

  setSetting(key: string, value: unknown): void {
    this.db
      .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, JSON.stringify(value))
  }

  // ---------- messages ----------

  /** Inserts a message unless its id already exists. Returns true if it was new. */
  insertMessage(m: StoredMessage, receivedAt: number = Date.now()): boolean {
    const r = this.db
      .prepare(
        `INSERT INTO messages (id, author_id, body, sent_at, received_at, status)
         VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`
      )
      .run(m.id, m.authorId, m.body, m.sentAt, receivedAt, m.status)
    return r.changes === 1
  }

  getMessage(id: string): StoredMessage | undefined {
    const row = this.db.prepare('SELECT id, author_id, body, sent_at, status FROM messages WHERE id = ?').get(id) as Row | undefined
    return row && toStored(row)
  }

  /**
   * Advances the status of the given messages (never moves backwards).
   * Restricted to messages by `authorId` so a peer can't alter the other side's records.
   * Returns the ids that actually changed.
   */
  advanceStatus(ids: readonly string[], status: MessageStatus, authorId: string): string[] {
    if (ids.length === 0) return []
    const stmt = this.db.prepare(
      `UPDATE messages SET status = ? WHERE id = ? AND author_id = ? AND ${RANK} < ? RETURNING id`
    )
    const changed: string[] = []
    this.db.transaction(() => {
      for (const id of ids) {
        const row = stmt.get(status, id, authorId, RANK_OF[status]) as { id: string } | undefined
        if (row) changed.push(row.id)
      }
    })()
    return changed
  }

  /**
   * Advances the status of incoming messages (anyone but `selfId`), e.g. marking them read.
   * Not tied to one peer id, so history from before a reinstall on their side still works.
   */
  advanceStatusFromOthers(ids: readonly string[], status: MessageStatus, selfId: string): string[] {
    if (ids.length === 0) return []
    const stmt = this.db.prepare(
      `UPDATE messages SET status = ? WHERE id = ? AND author_id <> ? AND ${RANK} < ? RETURNING id`
    )
    const changed: string[] = []
    this.db.transaction(() => {
      for (const id of ids) {
        const row = stmt.get(status, id, selfId, RANK_OF[status]) as { id: string } | undefined
        if (row) changed.push(row.id)
      }
    })()
    return changed
  }

  /** Newest-last page of history, older than `before` when given. */
  listMessages(before: HistoryCursor | undefined, limit: number): { rows: StoredMessage[]; hasMore: boolean } {
    const rows = (
      before
        ? this.db
            .prepare(
              `SELECT id, author_id, body, sent_at, status FROM messages
               WHERE sent_at < ? OR (sent_at = ? AND id < ?)
               ORDER BY sent_at DESC, id DESC LIMIT ?`
            )
            .all(before.sentAt, before.sentAt, before.id, limit + 1)
        : this.db
            .prepare(`SELECT id, author_id, body, sent_at, status FROM messages ORDER BY sent_at DESC, id DESC LIMIT ?`)
            .all(limit + 1)
    ) as Row[]
    const hasMore = rows.length > limit
    return { rows: rows.slice(0, limit).reverse().map(toStored), hasMore }
  }
}

function toStored(r: Row): StoredMessage {
  return { id: r.id, authorId: r.author_id, body: r.body, sentAt: r.sent_at, status: r.status }
}

/** Converts a stored message for the UI, from this install's point of view. */
export function toChatMessage(m: StoredMessage, selfId: string): ChatMessage {
  return { id: m.id, from: m.authorId === selfId ? 'me' : 'peer', text: m.body, sentAt: m.sentAt, status: m.status }
}
