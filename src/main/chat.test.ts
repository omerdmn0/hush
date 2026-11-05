import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { afterEach, describe, expect, it } from 'vitest'
import type { HushEvent } from '../shared/types'
import { ChatService } from './chat'
import { HushDb } from './db'
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

interface Side {
  id: string
  db: HushDb
  link: PeerLink
  chat: ChatService
  events: HushEvent[]
}

function side(name: string, port: number, peerPort: number): Side {
  const dir = mkdtempSync(join(tmpdir(), `hush-chat-${name}-`))
  const db = new HushDb(join(dir, 'hush.db'))
  const id = randomUUID()
  const link = new PeerLink({ selfId: id, name, bindHost: HOST, port, peerHost: HOST, peerPort })
  const events: HushEvent[] = []
  const chat = new ChatService(db, link, id, (e) => events.push(e))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  cleanups.push(() => db.close())
  cleanups.push(() => link.stop())
  return { id, db, link, chat, events }
}

const until = async (cond: () => boolean, ms = 4000): Promise<void> => {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 20))
  }
}

async function connected(): Promise<[Side, Side]> {
  const [pa, pb] = [await freePort(), await freePort()]
  const a = side('Alice', pa, pb)
  const b = side('Bob', pb, pa)
  a.link.start()
  b.link.start()
  await until(() => a.link.peer !== null && b.link.peer !== null)
  return [a, b]
}

describe('ChatService', () => {
  it('sends a message, stores it on both sides, and walks sent → delivered → read', async () => {
    const [a, b] = await connected()
    const sent = await a.chat.send('  hello Bob  ')
    expect(sent.text).toBe('hello Bob')

    await until(() => b.db.getMessage(sent.id) !== undefined)
    expect(b.db.getMessage(sent.id)).toMatchObject({ authorId: a.id, body: 'hello Bob', status: 'delivered' })
    expect(b.events.some((e) => e.type === 'message' && e.message.from === 'peer')).toBe(true)

    await until(() => a.db.getMessage(sent.id)?.status === 'delivered')
    b.chat.markRead([sent.id])
    await until(() => a.db.getMessage(sent.id)?.status === 'read')
    expect(b.db.getMessage(sent.id)?.status).toBe('read')

    // Status events for the sender went queued → sent → delivered → read, in order.
    const statuses = a.events.flatMap((e) => (e.type === 'status' ? e.updates.map((u) => u.status) : []))
    expect(statuses).toEqual(['sent', 'delivered', 'read'])
  })

  it('keeps a message queued when the peer is offline', async () => {
    const [pa, pb] = [await freePort(), await freePort()]
    const a = side('Alice', pa, pb)
    a.link.start()
    const m = await a.chat.send('anyone there?')
    expect(m.status).toBe('queued')
    expect(a.db.getMessage(m.id)?.status).toBe('queued')
  })

  it('forwards typing and remembers the peer name and last seen', async () => {
    const [a, b] = await connected()
    expect(a.chat.peerState()).toMatchObject({ name: 'Bob', presence: 'online' })
    b.chat.setTyping(true)
    await until(() => a.events.some((e) => e.type === 'typing' && e.on))

    await b.link.stop()
    await until(() => a.chat.peerState().presence === 'offline')
    expect(a.chat.peerState().name).toBe('Bob')
    expect(a.chat.peerState().lastSeen).toBeGreaterThan(Date.now() - 5000)
  })

  it('ignores a message whose author is not the connected peer', async () => {
    const [a, b] = await connected()
    const forged = randomUUID()
    await b.link.send({ t: 'msg', id: forged, author: randomUUID(), body: 'spoofed', sentAt: Date.now() })
    await b.link.send({ t: 'typing', on: true }) // ordering marker
    await until(() => a.events.some((e) => e.type === 'typing'))
    expect(a.db.getMessage(forged)).toBeUndefined()
  })

  it('stores a re-sent message only once and acks it again', async () => {
    const [a, b] = await connected()
    const id = randomUUID()
    const frame = { t: 'msg' as const, id, author: b.id, body: 'twice', sentAt: Date.now() }
    await b.link.send(frame)
    await b.link.send(frame)
    await until(() => a.db.getMessage(id) !== undefined)
    await new Promise((r) => setTimeout(r, 200))
    expect(a.events.filter((e) => e.type === 'message')).toHaveLength(1)
  })
})
