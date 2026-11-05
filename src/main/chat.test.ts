import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes, randomUUID } from 'node:crypto'
import { crc32, deflateSync } from 'node:zlib'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { decodeChunk, type Frame } from '../shared/protocol'
import type { HushEvent } from '../shared/types'
import { AWAITING_SYNC, ChatService } from './chat'
import { HushDb } from './db'
import { ImageStore } from './images'
import { Avatars } from './avatars'
import { Identity } from './identity'
import { fieldCipher, newDataKey, readEncryptedFile, writeEncryptedFile } from './vault'
import { PeerLink } from './link'
import { freePort } from './testPorts'

const HOST = '127.0.0.1'
const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c()
})


/** One "computer": a database that survives while the app (link + chat service) restarts. */
class Side {
  readonly db: HushDb
  readonly store: ImageStore
  readonly avatars: Avatars
  readonly events: HushEvent[] = []
  link!: PeerLink
  chat!: ChatService
  readonly identity = new Identity(Identity.generate())
  /** Everything at rest is encrypted, as in the real app. */
  readonly key = newDataKey()
  /** Paired peer key (set by `sides()`). */
  peerKey: string | null = null

  constructor(
    readonly name: string,
    /** Changes only when a reinstalled app takes over its old id (history recovery). */
    public id: string,
    private readonly port: number,
    private readonly peerPort: number,
    file?: string
  ) {
    const dir = mkdtempSync(join(tmpdir(), `hush-chat-${name}-`))
    this.db = new HushDb(file ?? join(dir, 'hush.db'), fieldCipher(this.key))
    this.store = new ImageStore(join(dir, 'images'), this.key)
    this.avatars = new Avatars(dir, this.key)
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
    cleanups.push(() => this.db.close())
  }

  /** Starts the app's networking (a fresh link + chat service, like an app launch). */
  start(): this {
    this.link = new PeerLink({
      selfId: this.id,
      name: this.name,
      appVersion: '0.2.0',
      identity: this.identity,
      pinned: () => this.peerKey,
      bindHost: HOST,
      port: this.port,
      peerHost: HOST,
      peerPort: this.peerPort
    })
    // Tiny chunks so every test image spans many chunks (exercises resume and ordering).
    this.chat = new ChatService(this.db, this.link, this.id, (e) => this.events.push(e), this.store, { chunkBytes: 1024, avatars: this.avatars })
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

const pairUp = (a: Side, b: Side): [Side, Side] => {
  a.peerKey = b.identity.publicKey
  b.peerKey = a.identity.publicKey
  return [a, b]
}

async function sides(): Promise<[Side, Side]> {
  const [pa, pb] = [await freePort(), await freePort()]
  return pairUp(new Side('Alice', randomUUID(), pa, pb), new Side('Bob', randomUUID(), pb, pa))
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

    const [a, b] = pairUp(new Side('Alice', aId, pa, pb, fileA), new Side('Bob', bId, pb, pa, fileB))
    a.start()
    b.start()
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
const fullFile = (s: Side, id: string): string => s.store.fullPath(id, { mime: 'image/png', size: 0, sha256: '' })
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
    expect(Buffer.compare(readEncryptedFile(b.key, fullFile(b, m.id)), Buffer.from(bytes))).toBe(0)
    expect(readFileSync(fullFile(b, m.id)).includes(Buffer.from(bytes).subarray(100, 140))).toBe(false) // encrypted on disk
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
    // Interrupt from inside B's chunk handling once 40 KB are stored. (Polling for that moment
    // raced the download: on a fast run all of it arrived between two polls and the test hung.)
    let stopping: Promise<void> | null = null
    b.link.on('binary', (data) => {
      const chunk = decodeChunk(data)
      if (!stopping && chunk && b.store.partSize(chunk.id) > 40_000) stopping = b.stop()
    })
    const m = await a.chat.sendImage(outgoing(bytes), '')
    await until(() => stopping !== null, 10_000)
    await stopping
    const partial = b.store.partSize(m.id)
    expect(partial).toBeGreaterThan(0)
    expect(partial).toBeLessThan(bytes.length)

    b.start()
    await until(() => transfer(b, m.id, 'done') && existsSync(fullFile(b, m.id)), 15_000)
    expect(Buffer.compare(readEncryptedFile(b.key, fullFile(b, m.id)), Buffer.from(bytes))).toBe(0)
  })

  it('rejects a corrupted transfer after a few attempts and reports it as failed', async () => {
    const [a, b] = await sides()
    a.start()
    const bytes = png(64, 48, true)
    const m = await a.chat.sendImage(outgoing(bytes), '')
    // The sender's file changes after sending, so its SHA-256 no longer matches.
    const tampered = Buffer.from(bytes)
    tampered[tampered.length - 20] ^= 0xff
    writeEncryptedFile(a.key, fullFile(a, m.id), tampered)
    b.start()
    await until(() => transfer(b, m.id, 'failed'), 10_000)
    expect(existsSync(fullFile(b, m.id))).toBe(false)
    expect(b.store.partSize(m.id)).toBe(0)
  })

  it('only serves images it holds in full', async () => {
    const [a, b] = await sides()
    a.start()
    b.start()
    await online(a, b)
    const replies: Frame[] = []
    a.link.on('frame', (f) => replies.push(f))
    const unknown = randomUUID()
    await a.link.send({ t: 'blob-req', id: unknown, offset: 0 })
    await until(() => replies.some((f) => f.t === 'blob-err' && f.id === unknown))
  })

  it('refuses files that are not really images', async () => {
    const [a] = await sides()
    a.start()
    const fake = new TextEncoder().encode('<svg onload="alert(1)"></svg>')
    await expect(a.chat.sendImage({ ...outgoing(fake), mime: 'image/png' }, '')).rejects.toThrow()
    expect(a.count()).toBe(0)
  })
})

describe('ChatService — avatars', () => {
  it('sends the profile picture on connect, on change, and removes it', async () => {
    const [a, b] = await sides()
    a.start()
    const pic = png(64, 64)
    expect(a.chat.setAvatar(pic)).toBe(true) // set while offline: goes out on connect
    expect(a.chat.setAvatar(new TextEncoder().encode('<svg/>'))).toBe(false)
    b.start()
    await until(() => b.avatars.has('peer'))
    expect(Buffer.compare(b.avatars.readForDisplay('peer')!, Buffer.from(pic))).toBe(0)
    expect(b.avatars.urls().peer).toMatch(/^hush-img:\/\/avatar\/peer\?v=\d+$/)

    a.chat.setAvatar(null)
    await until(() => !b.avatars.has('peer'))
    expect(b.events.filter((e) => e.type === 'avatars').length).toBeGreaterThanOrEqual(2)
  })
})

describe('ChatService — events', () => {
  it('syncs events made offline and keeps them out of the message list', async () => {
    const [a, b] = await sides()
    a.start()
    b.start()
    await online(a, b)
    const m = await a.chat.send('original')
    await until(() => b.db.getMessage(m.id) !== undefined)
    await b.stop()
    await until(() => a.link.peer === null)
    const edit = await a.chat.sendEvent('edit', m.id, 'edited text')
    const react = await a.chat.sendEvent('react', m.id, '🔥')
    expect(a.db.getMessage(edit.id)?.status).toBe('queued')
    b.start()
    await until(() => b.db.getMessage(react.id) !== undefined)
    expect(b.db.getMessage(edit.id)).toMatchObject({ kind: 'edit', ref: m.id, data: 'edited text' })
    expect(b.db.listMessages(undefined, 50).rows.map((r) => r.id)).toEqual([m.id])
    expect(b.events.filter((e) => e.type === 'event' && e.target === m.id).length).toBe(2)
    expect(b.db.unreadCount(b.id)).toBe(1)
  })

  it('stores an unknown message kind from a newer Hush and shows a placeholder', async () => {
    const [a, b] = await sides()
    a.start()
    b.start()
    await online(a, b)
    const id = randomUUID()
    await b.link.send({ t: 'msg', id, author: b.id, seq: 1, body: '', sentAt: Date.now(), kind: 'poll', data: '{}' })
    await until(() => a.db.getMessage(id) !== undefined)
    const shown = a.events.find((e) => e.type === 'message' && e.message.id === id)
    expect(shown?.type === 'message' && shown.message.unsupported).toBe(true)
  })
})

describe('ChatService — recovering history after a reinstall', () => {
  it('gives a fresh install its old id, then sends back its own messages and images', async () => {
    const [pa, pb] = [await freePort(), await freePort()]
    const bobId = randomUUID()
    const [a, b] = pairUp(new Side('Alice', randomUUID(), pa, pb), new Side('Bob', bobId, pb, pa))
    a.start()
    b.start()
    await online(a, b)
    await b.chat.send('bob one')
    await a.chat.send('alice one')
    const img = await b.chat.sendImage(outgoing(png(40, 30, true)), 'bob picture')
    await b.chat.send('bob two')
    await until(() => a.count() === 4 && transfer(a, img.id, 'done'), 10_000)
    await b.stop()

    // Bob reinstalls: new device id, new identity, empty database. They pair again.
    const fresh = new Side('Bob', randomUUID(), pb, pa)
    pairUp(a, fresh)
    fresh.start()
    await online(a, fresh)
    await until(() => fresh.count() === 1) // Alice's own message comes over by itself
    expect(fresh.chat.hasOwnMessages()).toBe(false)

    const prev = await fresh.chat.askPreviousId()
    expect(prev).toEqual({ id: bobId, seq: 3 })

    // Take over the old id (the app restarts to do this).
    await fresh.stop()
    fresh.id = prev!.id
    fresh.db.setSetting(`seqFloor:${prev!.id}`, prev!.seq)
    fresh.start()
    await online(a, fresh)
    await until(() => fresh.count() === 4 && existsSync(fullFile(fresh, img.id)), 10_000)
    const mine = fresh.chat
      .listMessages(undefined, 50)
      .messages.filter((m) => m.from === 'me')
      .map((m) => m.text)
      .sort() // sent within the same millisecond, so their display order isn't fixed
    expect(mine).toEqual(['bob one', 'bob picture', 'bob two'])
    expect(readEncryptedFile(fresh.key, fullFile(fresh, img.id)).equals(readEncryptedFile(a.key, fullFile(a, img.id)))).toBe(true)

    // New messages continue the old numbering, so nothing collides at Alice's end.
    const next = await fresh.chat.send('bob three')
    expect(fresh.db.getMessage(next.id)?.seq).toBe(4)
    await until(() => a.db.getMessage(next.id) !== undefined)
    expect(a.db.getSetting('previousPeerId')).toBeNull()
  })

  it('has nothing to recover when the peer never saw another id', async () => {
    const [a, b] = await sides()
    a.start()
    b.start()
    await online(a, b)
    expect(await b.chat.askPreviousId()).toBeNull()
  })
})

describe('ChatService — after restoring an older backup', () => {
  it('waits for the peer, gets the lost messages back and numbers new ones after them', async () => {
    const [a, b] = await sides()
    a.start()
    b.start()
    await online(a, b)
    const lost = []
    for (const t of ['one', 'two', 'three']) lost.push(await a.chat.send(t))
    await until(() => b.count() === 3)
    await a.stop()
    await until(() => b.link.peer === null)

    // A restores a backup made after "one": "two" and "three" are gone locally.
    a.sql('DELETE FROM messages WHERE id IN (?, ?)', lost[1].id, lost[2].id)
    a.db.setSetting(AWAITING_SYNC, true)
    a.start()
    expect(a.chat.peerState().catchingUp).toBe(true)
    await expect(a.chat.send('too early')).rejects.toThrow(/Catching up/)

    await online(a, b)
    await until(() => a.count() === 3 && !a.chat.peerState().catchingUp)
    expect(a.db.getMessage(lost[2].id)?.body).toBe('three')
    const next = await a.chat.send('four')
    expect(a.db.getMessage(next.id)?.seq).toBe(4)
    await until(() => b.db.getMessage(next.id) !== undefined)
    expect(b.count()).toBe(4)
  })
})

describe('ChatService — message actions', () => {
  const view = (s: Side, id: string) => s.chat.getMessages([id])[0]

  it('replies show what they answer, on both sides', async () => {
    const [a, b] = await sides()
    a.start()
    b.start()
    await online(a, b)
    const q = await a.chat.send('lunch?')
    await until(() => b.db.getMessage(q.id) !== undefined)
    const r = await b.chat.send('yes!', q.id)
    await until(() => a.db.getMessage(r.id) !== undefined)
    expect(view(a, r.id).replyTo).toEqual({ id: q.id, missing: false, from: 'me', text: 'lunch?', hasImage: false, deleted: false })
    expect(view(b, r.id).replyTo).toMatchObject({ from: 'peer', text: 'lunch?' })
    await expect(b.chat.send('x', randomUUID())).rejects.toThrow()
  })

  it('edits by the author reach the peer; edits by anyone else are ignored', async () => {
    const [a, b] = await sides()
    a.start()
    b.start()
    await online(a, b)
    const m = await a.chat.send('helo')
    await until(() => b.db.getMessage(m.id) !== undefined)
    await a.chat.edit(m.id, 'hello')
    await until(() => view(b, m.id).text === 'hello')
    expect(view(b, m.id).editedAt).toBeGreaterThan(0)
    await expect(b.chat.edit(m.id, 'not yours')).rejects.toThrow(/Not your message/)
    await b.chat.sendEvent('edit', m.id, 'forged') // a modified app trying anyway
    await settle()
    expect(view(a, m.id).text).toBe('hello')
    expect(view(b, m.id).text).toBe('hello')
  })

  it('delete for everyone erases text and picture on both computers; forged deletes do nothing', async () => {
    const [a, b] = await sides()
    a.start()
    b.start()
    await online(a, b)
    const keep = await b.chat.send('mine to keep')
    const img = await a.chat.sendImage(outgoing(png(32, 24)), 'secret caption')
    await until(() => transfer(b, img.id, 'done') && a.db.getMessage(keep.id) !== undefined)
    await a.chat.edit(img.id, 'secret caption v2')
    await b.chat.sendEvent('delete', img.id, null) // forged: B didn't write it
    await settle()
    expect(view(a, img.id).deleted).toBeUndefined()

    await a.chat.deleteForEveryone(img.id)
    await until(() => view(b, img.id).deleted === true)
    for (const s of [a, b]) {
      expect(view(s, img.id)).toMatchObject({ deleted: true, text: '' })
      expect(view(s, img.id).image).toBeUndefined()
      expect(s.db.getMessage(img.id)?.body).toBe('')
      expect(existsSync(fullFile(s, img.id))).toBe(false)
      expect(existsSync(s.store.thumbPath(img.id))).toBe(false)
      expect(JSON.stringify(s.db.eventsFor([img.id]))).not.toContain('secret')
    }
    expect(view(a, keep.id).text).toBe('mine to keep')
    await expect(a.chat.edit(img.id, 'again')).rejects.toThrow(/deleted/)
  })

  it('reactions: several per person, toggled, and synced after being offline', async () => {
    const [a, b] = await sides()
    a.start()
    b.start()
    await online(a, b)
    const m = await a.chat.send('good news')
    await until(() => b.db.getMessage(m.id) !== undefined)
    await b.stop()
    await a.chat.react(m.id, '🔥', true)
    await a.chat.react(m.id, '❤️', true)
    await a.chat.react(m.id, '🔥', true) // already on: no new event
    await a.chat.react(m.id, '❤️', false)
    b.start()
    await online(a, b)
    await b.chat.react(m.id, '🔥', true)
    await until(() => (view(a, m.id).reactions ?? []).some((r) => r.theirs))
    await until(() => (view(b, m.id).reactions ?? []).length === 1)
    expect(view(a, m.id).reactions).toEqual([{ emoji: '🔥', mine: true, theirs: true }])
    expect(view(b, m.id).reactions).toEqual([{ emoji: '🔥', mine: true, theirs: true }])
    expect(a.db.eventsFor([m.id]).filter((e) => e.authorId === a.id).length).toBe(3) // +🔥 +❤️ -❤️, no duplicate
    await expect(a.chat.react(m.id, 'lol', true)).rejects.toThrow()
  })

  it('delete for me hides it here only, and a reply to it says so', async () => {
    const [a, b] = await sides()
    a.start()
    b.start()
    await online(a, b)
    const m = await b.chat.send('embarrassing')
    await until(() => a.db.getMessage(m.id) !== undefined)
    const r = await a.chat.send('haha', m.id)
    await until(() => b.db.getMessage(r.id) !== undefined)
    a.chat.deleteForMe(m.id)
    expect(a.chat.getMessages([m.id])).toEqual([])
    expect(a.chat.listMessages(undefined, 50).messages.map((x) => x.id)).toEqual([r.id])
    expect(view(a, r.id).replyTo).toEqual({ id: m.id, missing: true })
    expect(view(b, m.id).text).toBe('embarrassing') // still there for B
    await b.stop()
    await until(() => a.link.peer === null)
    const queued = await a.chat.send('not sent yet')
    expect(() => a.chat.deleteForMe(queued.id)).toThrow(/Not sent yet/)
  })
})

describe('ChatService — search', () => {
  it('finds current text only, and stays up to date with new, edited and deleted messages', async () => {
    const [a, b] = await sides()
    a.start()
    b.start()
    await online(a, b)
    // A few ms apart, so "newest first" has a defined order.
    const m1 = await a.chat.send('Yarın İstanbul’a gidiyoruz')
    await settle(5)
    const m2 = await b.chat.send('Şeker getir lütfen')
    await settle(5)
    const typo = await a.chat.send('meet at the libary')
    await settle(5)
    const gone = await b.chat.send('secret plan istanbul')
    await settle(5)
    const hidden = await b.chat.send('istanbul again, hide me')
    await until(() => a.count() === 5)
    const ids = (q: string): string[] => a.chat.search(q).results.map((r) => r.id)

    expect(ids('istanbul')).toEqual([hidden.id, gone.id, m1.id]) // newest first
    expect(a.chat.search('seker')).toMatchObject({ results: [{ id: m2.id, from: 'peer', text: 'Şeker getir lütfen' }], more: false })

    // Kept current after the first search (the cache is built by now):
    await a.chat.edit(typo.id, 'meet at the library')
    expect(ids('libary')).toEqual([])
    expect(ids('library')).toEqual([typo.id])
    await b.chat.deleteForEveryone(gone.id)
    await until(() => !ids('istanbul').includes(gone.id))
    a.chat.deleteForMe(hidden.id)
    expect(ids('istanbul')).toEqual([m1.id])
    await settle(5)
    const late = await b.chat.send('istanbul tomorrow?')
    await until(() => ids('istanbul').includes(late.id))
    expect(ids('istanbul')).toEqual([late.id, m1.id])
    expect(ids('   ')).toEqual([])
  })
})

describe('ChatService — files and voice notes', () => {
  const tmpFile = (bytes: Uint8Array, name: string): string => {
    const dir = mkdtempSync(join(tmpdir(), 'hush-src-'))
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
    const p = join(dir, name)
    writeFileSync(p, bytes)
    return p
  }

  it('sends a file of any type from disk; the peer can save an identical copy', async () => {
    const [a, b] = await sides()
    a.start()
    b.start()
    await online(a, b)
    const bytes = randomBytes(3 * 1024 * 1024 + 123) // many chunks (1 KB in tests)
    const src = tmpFile(bytes, 'report final.pdf')
    const m = await a.chat.sendFile(src, 'the report')
    expect(m.file).toMatchObject({ name: 'report final.pdf', size: bytes.length, mime: 'application/pdf', ready: true, risky: false })
    await until(() => transfer(b, m.id, 'done'), 30_000)
    const view = b.chat.getMessages([m.id])[0]
    expect(view).toMatchObject({ text: 'the report', file: { name: 'report final.pdf', ready: true } })
    const out = join(mkdtempSync(join(tmpdir(), 'hush-out-')), 'saved.pdf')
    await b.chat.exportAttachment(m.id, out)
    expect(readFileSync(out).equals(bytes)).toBe(true)
    // Stored encrypted, like everything else.
    expect(readFileSync(b.store.fullPath(m.id, { size: 0, sha256: '', mime: '', file: 'file' })).includes(bytes.subarray(1000, 1040))).toBe(false)
    expect(b.chat.search('report final').results.map((r) => r.id)).toEqual([m.id])
  }, 40_000)

  it('flags programs, refuses folders and empty files', async () => {
    const [a] = await sides()
    a.start()
    const m = await a.chat.sendFile(tmpFile(Buffer.from('MZ fake program'), 'setup.exe'), '')
    expect(m.file?.risky).toBe(true)
    await expect(a.chat.sendFile(tmpdir(), '')).rejects.toThrow()
    await expect(a.chat.sendFile(tmpFile(new Uint8Array(0), 'empty.txt'), '')).rejects.toThrow()
  })

  it('voice notes arrive with their length and waveform; deleting erases them everywhere', async () => {
    const [a, b] = await sides()
    a.start()
    b.start()
    await online(a, b)
    const peaks = Uint8Array.from({ length: 48 }, (_, i) => i * 5)
    const m = await a.chat.sendFileBytes(randomBytes(20_000), 'voice.webm', '', undefined, { durationMs: 4200, peaks })
    await until(() => transfer(b, m.id, 'done'))
    const v = b.chat.getMessages([m.id])[0].file!
    expect(v.voice).toMatchObject({ durationMs: 4200, peaks: [...peaks], url: `hush-img://${m.id}/voice` })
    expect(v.mime).toBe('audio/webm')
    const voiceFile = (s: Side): string => s.store.fullPath(m.id, { size: 0, sha256: '', mime: '', file: 'voice' })
    expect(existsSync(voiceFile(b))).toBe(true)
    await a.chat.deleteForEveryone(m.id)
    await until(() => b.chat.getMessages([m.id])[0].deleted === true)
    expect([existsSync(voiceFile(a)), existsSync(voiceFile(b))]).toEqual([false, false])
    await expect(a.chat.sendFileBytes(randomBytes(10), 'v.webm', '', undefined, { durationMs: 6 * 60_000, peaks })).rejects.toThrow()
  })
})
