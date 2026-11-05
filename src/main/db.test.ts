import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HushDb, toChatMessage, type StoredMessage } from './db'
import { fieldCipher, newDataKey } from './vault'

const ME = randomUUID()
const PEER = randomUUID()
let dir: string
let db: HushDb

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hush-db-'))
  db = new HushDb(join(dir, 'hush.db'))
})
afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

const make = (authorId: string, seq: number | null, sentAt: number, status: StoredMessage['status'] = 'sent'): StoredMessage => ({
  id: randomUUID(),
  authorId,
  seq,
  body: `msg ${seq} at ${sentAt}`,
  sentAt,
  status,
  image: null
})

describe('HushDb', () => {
  it('persists settings as JSON and survives reopening the file', () => {
    db.setSetting('settings', { displayName: 'Ömer', peerIp: '100.101.42.7' })
    db.setSetting('settings', { displayName: 'Ömer 2', peerIp: '100.101.42.7' })
    db.close()
    db = new HushDb(join(dir, 'hush.db'))
    expect(db.getSetting('settings')).toEqual({ displayName: 'Ömer 2', peerIp: '100.101.42.7' })
    expect(db.getSetting('missing')).toBeUndefined()
  })

  it('numbers own messages 1, 2, 3… per author', () => {
    const a = db.createOwnMessage(ME, 'one', 10)
    const b = db.createOwnMessage(ME, 'two', 20)
    db.insertMessage(make(PEER, 1, 15))
    const c = db.createOwnMessage(ME, 'three', 30)
    expect([a.seq, b.seq, c.seq]).toEqual([1, 2, 3])
    expect(a.status).toBe('queued')
  })

  it('ignores a duplicate message id (sync-safe insert)', () => {
    const m = make(PEER, 1, 1000, 'delivered')
    expect(db.insertMessage(m)).toBe(true)
    expect(db.insertMessage({ ...m, body: 'tampered' })).toBe(false)
    expect(db.getMessage(m.id)?.body).toBe(m.body)
  })

  it('fills in a missing sequence number when a known message is re-sent', () => {
    const legacy = make(PEER, null, 1000, 'delivered')
    db.insertMessage(legacy)
    expect(db.insertMessage({ ...legacy, seq: 5 })).toBe(false)
    expect(db.getMessage(legacy.id)?.seq).toBe(5)
  })

  it('only advances status forward and only for the given author', () => {
    const mine = db.createOwnMessage(ME, 'x', 1000)
    expect(db.advanceStatus([mine.id], 'sent', ME)).toEqual([mine.id])
    expect(db.advanceStatus([mine.id], 'read', ME)).toEqual([mine.id])
    expect(db.advanceStatus([mine.id], 'delivered', ME)).toEqual([]) // no going back
    expect(db.getMessage(mine.id)?.status).toBe('read')

    const theirs = make(PEER, 1, 2000, 'delivered')
    db.insertMessage(theirs)
    expect(db.advanceStatus([theirs.id], 'read', ME)).toEqual([])
    expect(db.advanceStatusFromOthers([theirs.id], 'read', ME)).toEqual([theirs.id])
  })

  it('computes the contiguous sequence watermark and stops at the first gap', () => {
    expect(db.contiguousSeq(PEER)).toBe(0)
    for (const s of [2, 3]) db.insertMessage(make(PEER, s, s))
    expect(db.contiguousSeq(PEER)).toBe(0) // #1 missing
    db.insertMessage(make(PEER, 1, 1))
    expect(db.contiguousSeq(PEER)).toBe(3)
    db.insertMessage(make(PEER, 5, 5))
    expect(db.contiguousSeq(PEER)).toBe(3) // #4 missing
    db.insertMessage(make(PEER, 4, 4))
    expect(db.contiguousSeq(PEER)).toBe(5)
  })

  it('advances everything up to a watermark and reports the read watermark', () => {
    const own = [1, 2, 3].map((i) => db.createOwnMessage(ME, `m${i}`, i))
    expect(db.advanceUpTo(ME, 2, 'delivered').sort()).toEqual([own[0].id, own[1].id].sort())
    expect(db.getMessage(own[2].id)?.status).toBe('queued')
    expect(db.advanceUpTo(ME, 0, 'read')).toEqual([])

    for (const s of [1, 2, 3]) db.insertMessage(make(PEER, s, 10 + s, s < 3 ? 'read' : 'delivered'))
    expect(db.readSeq(PEER)).toBe(2)
    expect(db.messagesAfter(ME, 1, 10).map((m) => m.seq)).toEqual([2, 3])
    expect(db.idsWithStatus(ME, ['queued'])).toEqual([own[2].id])
  })

  it('pages history newest-last with a stable cursor, including equal timestamps', () => {
    const all = [make(ME, 1, 1), make(PEER, 1, 2), make(ME, 2, 3), make(PEER, 2, 3), make(ME, 3, 4)]
    for (const m of all) db.insertMessage(m)
    const expected = [...all].sort((a, b) => a.sentAt - b.sentAt || a.id.localeCompare(b.id)).map((m) => m.id)

    const p1 = db.listMessages(undefined, 2)
    expect(p1.hasMore).toBe(true)
    const p2 = db.listMessages({ sentAt: p1.rows[0].sentAt, id: p1.rows[0].id }, 2)
    const p3 = db.listMessages({ sentAt: p2.rows[0].sentAt, id: p2.rows[0].id }, 2)
    expect(p3.hasMore).toBe(false)
    expect([...p3.rows, ...p2.rows, ...p1.rows].map((m) => m.id)).toEqual(expected)
  })

  it('maps authors to me/peer for the UI', () => {
    const m = make(ME, 1, 5)
    expect(toChatMessage(m, ME).from).toBe('me')
    expect(toChatMessage(m, PEER).from).toBe('peer')
  })
})

describe('migration from stage b (v1)', () => {
  it('numbers only this install’s own messages, in time order; the peer’s stay unnumbered', () => {
    const file = join(dir, 'legacy.db')
    const raw = new Database(file)
    raw.exec(`
      CREATE TABLE messages (id TEXT PRIMARY KEY, author_id TEXT NOT NULL, body TEXT NOT NULL,
        sent_at INTEGER NOT NULL, received_at INTEGER NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('queued','sent','delivered','read')));
      CREATE INDEX messages_by_time ON messages (sent_at, id);
      CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      PRAGMA user_version = 1;`)
    raw.prepare(`INSERT INTO settings VALUES ('selfId', ?)`).run(JSON.stringify(ME))
    const ins = raw.prepare('INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?)')
    const ids = { mineLate: randomUUID(), mineEarly: randomUUID(), theirs: randomUUID() }
    ins.run(ids.mineLate, ME, 'late', 300, 300, 'queued')
    ins.run(ids.mineEarly, ME, 'early', 100, 100, 'read')
    ins.run(ids.theirs, PEER, 'hi', 200, 200, 'read')
    raw.close()

    const migrated = new HushDb(file)
    expect(migrated.version).toBe(5)
    expect(migrated.getMessage(ids.mineEarly)?.seq).toBe(1)
    expect(migrated.getMessage(ids.mineLate)?.seq).toBe(2)
    expect(migrated.getMessage(ids.theirs)?.seq).toBeNull()
    expect(migrated.contiguousSeq(PEER)).toBe(0) // so the peer re-sends and fills it in
    expect(migrated.createOwnMessage(ME, 'next', 400).seq).toBe(3)
    migrated.close()
  })
})

describe('call history', () => {
  it('stores, updates and lists call records in time order', () => {
    const a = randomUUID()
    const b = randomUUID()
    db.logCall({ id: b, direction: 'in', startedAt: 200, connectedAt: null, endedAt: 230, outcome: 'missed' })
    db.logCall({ id: a, direction: 'out', startedAt: 100, connectedAt: 105, endedAt: null, outcome: 'ongoing' })
    db.logCall({ id: a, direction: 'out', startedAt: 100, connectedAt: 105, endedAt: 400, outcome: 'completed' })
    expect(db.listCalls().map((c) => [c.id, c.outcome, c.endedAt])).toEqual([
      [a, 'completed', 400],
      [b, 'missed', 230]
    ])
    expect(() => db.logCall({ id: 'nope', direction: 'out', startedAt: 1, connectedAt: null, endedAt: null, outcome: 'missed' })).toThrow()
  })

  it('closes calls left "ongoing" when Hush quit mid-call', () => {
    const live = randomUUID()
    const ringing = randomUUID()
    db.logCall({ id: live, direction: 'out', startedAt: 1, connectedAt: 5, endedAt: null, outcome: 'ongoing' })
    db.logCall({ id: ringing, direction: 'in', startedAt: 2, connectedAt: null, endedAt: null, outcome: 'ongoing' })
    db.close()
    db = new HushDb(join(dir, 'hush.db'))
    expect(db.listCalls().map((c) => c.outcome)).toEqual(['completed', 'failed'])
  })
})

describe('encryption at rest', () => {
  it('stores message text and event data sealed, reads them back, and upgrades old rows', () => {
    const file = join(dir, 'enc.db')
    const plain = new HushDb(file) // an older, unencrypted database
    const old = make(PEER, 1, 10, 'read')
    plain.insertMessage({ ...old, body: 'from before encryption' })
    plain.setSetting('identityKey', 'PRIVATE-KEY')
    plain.close()

    const key = newDataKey()
    const enc = new HushDb(file, fieldCipher(key))
    expect(enc.encryptExisting(['identityKey'])).toBe(1)
    const fresh = make(ME, 1, 20)
    enc.insertMessage({ ...fresh, body: 'gizli 🌙', kind: 'message', data: null })
    enc.insertMessage({ ...make(ME, 2, 30), body: '', kind: 'edit', ref: fresh.id, data: 'new secret text' })
    expect(enc.getMessage(old.id)?.body).toBe('from before encryption')
    expect(enc.getMessage(fresh.id)?.body).toBe('gizli 🌙')
    expect(enc.getSecret('identityKey')).toBe('PRIVATE-KEY')
    enc.close()

    const raw = new Database(file)
    const dump = JSON.stringify(raw.prepare('SELECT body, data FROM messages').all()) + JSON.stringify(raw.prepare('SELECT * FROM settings').all())
    raw.close()
    for (const secret of ['from before encryption', 'gizli', 'new secret text', 'PRIVATE-KEY']) expect(dump).not.toContain(secret)

    // The wrong key can't read it.
    const wrong = new HushDb(file, fieldCipher(newDataKey()))
    expect(() => wrong.getMessage(fresh.id)).toThrow()
    wrong.close()
  })
})
