import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { crc32, deflateSync } from 'node:zlib'
import { once } from 'node:events'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import type { Frame } from '../shared/protocol'
import type { HushEvent } from '../shared/types'
import { ChatService } from './chat'
import { HushDb } from './db'
import { ImageStore } from './images'
import { PeerLink } from './link'

const HOST = '127.0.0.1'
const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c()
})

async function freePort(): Promise<number> {
  const srv = createServer()
  srv.listen(0, HOST)
  await once(srv, 'listening')
  const port = (srv.address() as { port: number }).port
  await new Promise((r) => srv.close(r))
  return port
}

/** One "computer": a database that survives while the app (link + chat service) restarts. */
class Side {
  readonly db: HushDb
  readonly store: ImageStore
  readonly events: HushEvent[] = []
  link!: PeerLink
  chat!: ChatService

  constructor(
    readonly name: string,
    readonly id: string,
    private readonly port: number,
    private readonly peerPort: number,
    file?: string
  ) {
    const dir = mkdtempSync(join(tmpdir(), `hush-chat-${name}-`))
    this.db = new HushDb(file ?? join(dir, 'hush.db'))
    this.store = new ImageStore(join(dir, 'images'))
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
    cleanups.push(() => this.db.close())
  }

  /** Starts the app's networking (a fresh link + chat service, like an app launch). */
  start(): this {
    this.link = new PeerLink({ selfId: this.id, name: this.name, bindHost: HOST, port: this.port, peerHost: HOST, peerPort: this.peerPort })
    // Tiny chunks so every test image spans many chunks (exercises resume and ordering).
    this.chat = new ChatService(this.db, this.link, this.id, (e) => this.events.push(e), this.store, { chunkBytes: 1024 })
    const link = this.link
    cleanups.push(() => link.stop())
    link.start()
    return this
  }

  stop(): Promise<void> {
    return this.link.stop()
  }

  count(): number {
    return ((this.db as unknown as { db: Database.Database }).db.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number }).n
  }

  sql(q: string, ...args: unknown[]): void {
    ;(this.db as unknown as { db: Database.Database }).db.prepare(q).run(...args)
  }
}

const until = async (cond: () => boolean, ms = 5000): Promise<void> => {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 20))
  }
}
const settle = (ms = 300): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function sides(): Promise<[Side, Side]> {
  const [pa, pb] = [await freePort(), await freePort()]
  return [new Side('Alice', randomUUID(), pa, pb), new Side('Bob', randomUUID(), pb, pa)]
}
const online = (a: Side, b: Side): Promise<void> => until(() => a.link.peer !== null && b.link.peer !== null)

describe('ChatService — live chat', () => {
  it('sends a message and walks sent → delivered → read', async () => {
    const [a, b] = await sides()
    a.start()
    b.start()
    await online(a, b)
    const sent = await a.chat.send('  hello Bob  ')
    expect(sent.text).toBe('hello Bob')

    await until(() => b.db.getMessage(sent.id) !== undefined)
    expect(b.db.getMessage(sent.id)).toMatchObject({ authorId: a.id, seq: 1, body: 'hello Bob', status: 'delivered' })
    await until(() => a.db.getMessage(sent.id)?.status === 'delivered')
    b.chat.markRead([sent.id])
    await until(() => a.db.getMessage(sent.id)?.status === 'read')

    const statuses = a.events.flatMap((e) => (e.type === 'status' ? e.updates.map((u) => u.status) : []))
    expect(statuses).toEqual(['sent', 'delivered', 'read'])
    expect(a.events.some((e) => e.type === 'flushed')).toBe(false) // nothing was queued
  })

  it('forwards typing and remembers the peer name and last seen', async () => {
    const [a, b] = await sides()
    a.start()
    b.start()
    await online(a, b)
    expect(a.chat.peerState()).toMatchObject({ name: 'Bob', presence: 'online' })
    b.chat.setTyping(true)
    await until(() => a.events.some((e) => e.type === 'typing' && e.on))
    await b.stop()
    await until(() => a.chat.peerState().presence === 'offline')
    expect(a.chat.peerState().lastSeen).toBeGreaterThan(Date.now() - 5000)
  })

  it('ignores a message whose author is not the connected peer', async () => {
    const [a, b] = await sides()
    a.start()
    b.start()
    await online(a, b)
    const forged = randomUUID()
    await b.link.send({ t: 'msg', id: forged, author: randomUUID(), seq: 1, body: 'spoofed', sentAt: Date.now() })
    await b.link.send({ t: 'typing', on: true })
    await until(() => a.events.some((e) => e.type === 'typing'))
    expect(a.db.getMessage(forged)).toBeUndefined()
  })
})

describe('ChatService — offline queue and sync', () => {
  it('delivers messages queued while the peer was offline, in order, and reports the flush', async () => {
    const [a, b] = await sides()
    a.start()
    const queued = [await a.chat.send('one'), await a.chat.send('two'), await a.chat.send('three')]
    expect(queued.map((m) => m.status)).toEqual(['queued', 'queued', 'queued'])

    b.start()
    await until(() => queued.every((m) => a.db.getMessage(m.id)?.status === 'delivered'))
    expect(b.db.messagesAfter(a.id, 0, 10).map((m) => m.body)).toEqual(['one', 'two', 'three'])
    await until(() => a.events.some((e) => e.type === 'flushed'))
    expect(a.events.filter((e) => e.type === 'flushed')).toEqual([expect.objectContaining({ type: 'flushed', count: 3 })])
  })

  it('syncs both directions when each side wrote while the other was away', async () => {
    const [a, b] = await sides()
    a.start()
    await a.chat.send('from A while B is away')
    await a.stop()
    b.start()
    await b.chat.send('from B while A is away')
    await b.stop()

    a.start()
    b.start()
    await until(() => a.count() === 2 && b.count() === 2)
    await settle()
    expect(a.db.idsWithStatus(a.id, ['delivered']).length).toBe(1)
    expect(b.db.idsWithStatus(b.id, ['delivered']).length).toBe(1)
  })

  it('recovers a lost acknowledgement on reconnect without duplicating the message', async () => {
    const [a, b] = await sides()
    a.start()
    b.start()
    await online(a, b)
    // Drop B's acks, as if the connection died right after the message arrived.
    const realSend = b.link.send.bind(b.link)
    b.link.send = (f: Frame) => (f.t === 'ack' ? Promise.resolve(true) : realSend(f))
    const m = await a.chat.send('did you get this?')
    await until(() => b.db.getMessage(m.id) !== undefined)
    await settle()
    expect(a.db.getMessage(m.id)?.status).toBe('sent')

    await b.stop()
    b.start()
    await until(() => a.db.getMessage(m.id)?.status === 'delivered')
    await settle()
    expect(b.count()).toBe(1)
  })

  it('carries read receipts made while offline over to the next connection', async () => {
    const [a, b] = await sides()
    a.start()
    b.start()
    await online(a, b)
    const m = await a.chat.send('read me later')
    await until(() => a.db.getMessage(m.id)?.status === 'delivered')
    await a.stop()
    b.chat.markRead([m.id]) // B reads while A is offline
    await settle()
    expect(a.db.getMessage(m.id)?.status).toBe('delivered')
    a.start()
    await until(() => a.db.getMessage(m.id)?.status === 'read')
  })

  it('fills a gap in history and never duplicates across repeated reconnects', async () => {
    const [a, b] = await sides()
    a.start()
    b.start()
    await online(a, b)
    for (let i = 1; i <= 5; i++) await a.chat.send(`m${i}`)
    await until(() => b.count() === 5)
    const second = b.db.messagesAfter(a.id, 1, 1)[0]
    b.sql('DELETE FROM messages WHERE id = ?', second.id) // B "loses" #2
    expect(b.db.contiguousSeq(a.id)).toBe(1)

    for (let cycle = 0; cycle < 3; cycle++) {
      await b.stop()
      b.start()
      await online(a, b)
      await settle()
    }
    expect(b.count()).toBe(5)
    expect(b.db.contiguousSeq(a.id)).toBe(5)
    expect(a.count()).toBe(5)
  })

  it('upgrades stage-b histories: undelivered messages go out, peer messages get their numbers', async () => {
    const [pa, pb] = [await freePort(), await freePort()]
    const [aId, bId] = [randomUUID(), randomUUID()]
    const dir = mkdtempSync(join(tmpdir(), 'hush-legacy-'))
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
    const legacy = (file: string, self: string, rows: [string, string, number, string][]): string => {
      const raw = new Database(join(dir, file))
      raw.exec(`CREATE TABLE messages (id TEXT PRIMARY KEY, author_id TEXT NOT NULL, body TEXT NOT NULL,
          sent_at INTEGER NOT NULL, received_at INTEGER NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('queued','sent','delivered','read')));
        CREATE INDEX messages_by_time ON messages (sent_at, id);
        CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL); PRAGMA user_version = 1;`)
      raw.prepare(`INSERT INTO settings VALUES ('selfId', ?)`).run(JSON.stringify(self))
      for (const [id, author, at, status] of rows) raw.prepare('INSERT INTO messages VALUES (?,?,?,?,?,?)').run(id, author, `body ${at}`, at, at, status)
      raw.close()
      return join(dir, file)
    }
    const [m1, m2, m3] = [randomUUID(), randomUUID(), randomUUID()]
    // A wrote m1 (delivered), m2 (queued, never delivered — stage b had no flush), B wrote m3.
    const fileA = legacy('a.db', aId, [[m1, aId, 100, 'read'], [m2, aId, 200, 'queued'], [m3, bId, 300, 'read']])
    const fileB = legacy('b.db', bId, [[m1, aId, 100, 'read'], [m3, bId, 300, 'read']])

    const a = new Side('Alice', aId, pa, pb, fileA).start()
    const b = new Side('Bob', bId, pb, pa, fileB).start()
    await until(() => b.count() === 3 && a.db.getMessage(m2)?.status === 'delivered')
    await settle()
    expect(b.db.getMessage(m2)?.seq).toBe(2)
    expect(b.db.getMessage(m1)?.seq).toBe(1) // filled in by A's re-send
    expect(a.db.getMessage(m3)?.seq).toBe(1) // filled in by B's re-send
    expect([a.count(), b.count()]).toEqual([3, 3])
  })
})

// ---------- images ----------

/** A real PNG; `noise` makes it barely compressible so it spans many chunks. */
function png(w: number, h: number, noise = false): Uint8Array {
  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const td = Buffer.concat([Buffer.from(type), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(td))
    return Buffer.concat([len, td, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr.set([8, 2, 0, 0, 0], 8) // 8-bit RGB
  const raw = Buffer.alloc((w * 3 + 1) * h)
  for (let i = 0; i < raw.length; i++) raw[i] = noise && i % (w * 3 + 1) !== 0 ? Math.floor(Math.random() * 256) : 0
  return new Uint8Array(
    Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
  )
}

const outgoing = (bytes: Uint8Array): { bytes: Uint8Array; mime: string; width: number; height: number; thumb: Uint8Array } => ({
  bytes,
  mime: 'image/png',
  width: 160,
  height: 120,
  thumb: png(16, 12)
})
const fullFile = (s: Side, id: string): string => s.store.fullPath(id, 'image/png')
const transfer = (s: Side, id: string, state: string): boolean =>
  s.events.some((e) => e.type === 'transfer' && e.transfer.id === id && e.transfer.state === state)

describe('ChatService — images', () => {
  it('shows the preview at once, then pulls the full image byte-for-byte', async () => {
    const [a, b] = await sides()
    a.start()
    b.start()
    await online(a, b)
    const bytes = png(160, 120, true) // ~58 KB → ~57 chunks of 1 KB
    const m = await a.chat.sendImage(outgoing(bytes), 'look at this')
    expect(m.image).toMatchObject({ mime: 'image/png', width: 160, height: 120, ready: true, thumbUrl: `hush-img://${m.id}/thumb` })

    await until(() => b.db.getMessage(m.id) !== undefined)
    expect(existsSync(b.store.thumbPath(m.id))).toBe(true)
    expect(b.db.getMessage(m.id)?.body).toBe('look at this')
    await until(() => transfer(b, m.id, 'done'), 10_000)
    expect(Buffer.compare(readFileSync(fullFile(b, m.id)), Buffer.from(bytes))).toBe(0)
    expect(transfer(a, m.id, 'done')).toBe(true) // sender saw its upload finish
  })

  it('delivers an image sent while the peer was offline', async () => {
    const [a, b] = await sides()
    a.start()
    const m = await a.chat.sendImage(outgoing(png(64, 48, true)), '')
    expect(m.status).toBe('queued')
    b.start()
    await until(() => transfer(b, m.id, 'done'), 10_000)
    expect(b.db.getMessage(m.id)?.body).toBe('')
    await until(() => a.db.getMessage(m.id)?.status === 'delivered')
  })

  it('resumes an interrupted download from where it stopped', async () => {
    const [a, b] = await sides()
    a.start()
    b.start()
    await online(a, b)
    const bytes = png(400, 300, true) // ~360 KB
    const m = await a.chat.sendImage(outgoing(bytes), '')
    await until(() => b.store.partSize(m.id) > 40_000, 10_000)
    await b.stop()
    const partial = b.store.partSize(m.id)
    expect(partial).toBeGreaterThan(0)
    expect(partial).toBeLessThan(bytes.length)

    b.start()
    await until(() => transfer(b, m.id, 'done') && existsSync(fullFile(b, m.id)), 15_000)
    expect(Buffer.compare(readFileSync(fullFile(b, m.id)), Buffer.from(bytes))).toBe(0)
  })

  it('rejects a corrupted transfer after a few attempts and reports it as failed', async () => {
    const [a, b] = await sides()
    a.start()
    const bytes = png(64, 48, true)
    const m = await a.chat.sendImage(outgoing(bytes), '')
    // The sender's file changes after sending, so its SHA-256 no longer matches.
    const tampered = Buffer.from(bytes)
    tampered[tampered.length - 20] ^= 0xff
    writeFileSync(fullFile(a, m.id), tampered)
    b.start()
    await until(() => transfer(b, m.id, 'failed'), 10_000)
    expect(existsSync(fullFile(b, m.id))).toBe(false)
    expect(b.store.partSize(m.id)).toBe(0)
  })

  it('only serves images it wrote itself', async () => {
    const [a, b] = await sides()
    a.start()
    b.start()
    await online(a, b)
    const m = await a.chat.sendImage(outgoing(png(32, 24)), '')
    await until(() => transfer(b, m.id, 'done'))
    const replies: Frame[] = []
    a.link.on('frame', (f) => replies.push(f))
    await a.link.send({ t: 'blob-req', id: m.id, offset: 0 }) // B holds it, but it's A's image
    await until(() => replies.some((f) => f.t === 'blob-err' && f.id === m.id))
  })

  it('refuses files that are not really images', async () => {
    const [a] = await sides()
    a.start()
    const fake = new TextEncoder().encode('<svg onload="alert(1)"></svg>')
    await expect(a.chat.sendImage({ ...outgoing(fake), mime: 'image/png' }, '')).rejects.toThrow()
    expect(a.count()).toBe(0)
  })
})
