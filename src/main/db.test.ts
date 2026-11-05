import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HushDb, toChatMessage, type StoredMessage } from './db'

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

const make = (authorId: string, sentAt: number, status: StoredMessage['status'] = 'sent'): StoredMessage => ({
  id: randomUUID(),
  authorId,
  body: `msg at ${sentAt}`,
  sentAt,
  status
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

  it('ignores a duplicate message id (sync-safe insert)', () => {
    const m = make(PEER, 1000, 'delivered')
    expect(db.insertMessage(m)).toBe(true)
    expect(db.insertMessage({ ...m, body: 'tampered' })).toBe(false)
    expect(db.getMessage(m.id)?.body).toBe(m.body)
  })

  it('only advances status forward and only for the given author', () => {
    const mine = make(ME, 1000, 'queued')
    db.insertMessage(mine)
    expect(db.advanceStatus([mine.id], 'sent', ME)).toEqual([mine.id])
    expect(db.advanceStatus([mine.id], 'read', ME)).toEqual([mine.id])
    expect(db.advanceStatus([mine.id], 'delivered', ME)).toEqual([]) // no going back
    expect(db.getMessage(mine.id)?.status).toBe('read')

    const theirs = make(PEER, 2000, 'delivered')
    db.insertMessage(theirs)
    // A receipt for "their" message claiming to come from me must not touch it.
    expect(db.advanceStatus([theirs.id], 'read', ME)).toEqual([])
    expect(db.advanceStatus([theirs.id], 'read', PEER)).toEqual([theirs.id])
  })

  it('pages history newest-last with a stable cursor, including equal timestamps', () => {
    const all = [make(ME, 1), make(PEER, 2), make(ME, 3), make(PEER, 3), make(ME, 4)]
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
    const m = make(ME, 5)
    expect(toChatMessage(m, ME).from).toBe('me')
    expect(toChatMessage(m, PEER).from).toBe('peer')
  })
})
