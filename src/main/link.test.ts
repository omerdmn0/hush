import { createServer } from 'node:net'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import WebSocket from 'ws'
import { afterEach, describe, expect, it } from 'vitest'
import { PeerLink, type LinkConfig } from './link'
import type { Frame } from '../shared/protocol'

const HOST = '127.0.0.1'

async function freePort(): Promise<number> {
  const srv = createServer()
  srv.listen(0, HOST)
  await once(srv, 'listening')
  const port = (srv.address() as { port: number }).port
  await new Promise((r) => srv.close(r))
  return port
}

const links: PeerLink[] = []
afterEach(async () => {
  await Promise.all(links.splice(0).map((l) => l.stop()))
})

function link(cfg: LinkConfig): PeerLink {
  const l = new PeerLink(cfg)
  links.push(l)
  return l
}

async function pair(): Promise<{ a: PeerLink; b: PeerLink; aCfg: LinkConfig; bCfg: LinkConfig }> {
  const [pa, pb] = [await freePort(), await freePort()]
  const aCfg: LinkConfig = { selfId: randomUUID(), name: 'Alice', bindHost: HOST, port: pa, peerHost: HOST, peerPort: pb }
  const bCfg: LinkConfig = { selfId: randomUUID(), name: 'Bob', bindHost: HOST, port: pb, peerHost: HOST, peerPort: pa }
  return { a: link(aCfg), b: link(bCfg), aCfg, bCfg }
}

const until = async (cond: () => boolean, ms = 4000): Promise<void> => {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 20))
  }
}

const openConns = (l: PeerLink): number =>
  [...(l as unknown as { conns: Set<{ ws: WebSocket }> }).conns].filter((c) => c.ws.readyState === WebSocket.OPEN).length

describe('PeerLink', () => {
  it('connects in both directions and settles on a single shared connection', async () => {
    const { a, b, aCfg, bCfg } = await pair()
    const upA = once(a, 'up')
    const upB = once(b, 'up')
    a.start()
    b.start()
    const [[peerOfA], [peerOfB]] = await Promise.all([upA, upB])
    expect(peerOfA).toEqual({ id: bCfg.selfId, name: 'Bob' })
    expect(peerOfB).toEqual({ id: aCfg.selfId, name: 'Alice' })
    // Both dialed; duplicates must be closed so exactly one connection remains on each side.
    await until(() => openConns(a) === 1 && openConns(b) === 1)
    await new Promise((r) => setTimeout(r, 300))
    expect(openConns(a)).toBe(1)
    expect(openConns(b)).toBe(1)
    expect(a.peer?.id).toBe(bCfg.selfId)
  })

  it('delivers frames and profile changes', async () => {
    const { a, b } = await pair()
    a.start()
    b.start()
    await until(() => a.peer !== null && b.peer !== null)
    await until(() => openConns(a) === 1 && openConns(b) === 1)

    const got: Frame[] = []
    b.on('frame', (f) => got.push(f))
    expect(await a.send({ t: 'typing', on: true })).toBe(true)
    a.update({ name: 'Alice 2' })
    await until(() => got.length === 2)
    expect(got[0]).toEqual({ t: 'typing', on: true })
    expect(got[1]).toEqual({ t: 'profile', name: 'Alice 2' })
    expect(b.peer?.name).toBe('Alice 2')
  })

  it('reports the peer going away and reconnects when it returns', async () => {
    const { a, b, bCfg } = await pair()
    a.start()
    b.start()
    await until(() => a.peer !== null)
    const down = once(a, 'down')
    await b.stop()
    await down
    expect(a.peer).toBeNull()
    expect(await a.send({ t: 'typing', on: false })).toBe(false)

    const b2 = link(bCfg) // same identity, restarted app
    const up = once(a, 'up')
    b2.start()
    const [peer] = await up
    expect(peer.id).toBe(bCfg.selfId)
  })

  it('refuses connections from any address other than the configured peer', async () => {
    const { a, b } = await pair()
    a.update({ peerHost: '127.0.0.2' }) // A expects someone else
    let up = false
    a.on('up', () => (up = true))
    b.on('up', () => (up = true))
    a.start()
    b.start()
    await new Promise((r) => setTimeout(r, 1200))
    expect(up).toBe(false)
  })

  it('rejects a peer speaking a different protocol version', async () => {
    const { a, aCfg } = await pair()
    a.start()
    await until(() => a.isListening)
    const problem = once(a, 'problem')
    const ws = new WebSocket(`ws://${HOST}:${aCfg.port}`)
    await once(ws, 'open')
    ws.send(JSON.stringify({ t: 'hello', v: 99, id: randomUUID(), name: 'Future' }))
    const [msg] = await problem
    expect(String(msg)).toContain('protocol v99')
    const [code] = await once(ws, 'close')
    expect(code).toBe(4001)
    expect(a.peer).toBeNull()
  })

  it('reports a busy port instead of crashing', async () => {
    const { a, aCfg } = await pair()
    a.start()
    await until(() => a.isListening)
    const clash = link({ ...aCfg, selfId: randomUUID() })
    const listening = once(clash, 'listening')
    clash.start()
    const [ok, error] = await listening
    expect(ok).toBe(false)
    expect(String(error)).toContain('already in use')
  })
})
