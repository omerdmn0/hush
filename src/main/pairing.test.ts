import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { PROTOCOL_VERSION } from '../shared/protocol'
import { Identity, normalizeCode, pairingProof } from './identity'
import { PeerLink } from './link'
import { CODE_TTL_MS, MAX_ATTEMPTS, PairingService } from './pairing'
import { freePort } from './testPorts'

const HOST = '127.0.0.1'
const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c()
})


const until = async (cond: () => boolean, ms = 5000): Promise<void> => {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 20))
  }
}

/** One app: identity, an in-memory "pinned key" store, link and pairing service. */
function app(name: string, port: number, peerPort: number, clock: { now: number } | null = null) {
  const identity = new Identity(Identity.generate())
  let pinned: string | null = null
  const link = new PeerLink({
    selfId: randomUUID(),
    name,
    appVersion: '0.2.0',
    identity,
    pinned: () => pinned,
    bindHost: HOST,
    port,
    peerHost: HOST,
    peerPort
  })
  const pairing = new PairingService(link, identity.publicKey, { getPinned: () => pinned, setPinned: (k) => (pinned = k) }, clock ? () => clock.now : Date.now)
  cleanups.push(() => link.stop())
  cleanups.push(() => pairing.dispose())
  return { identity, link, pairing, pinned: () => pinned }
}

async function twoApps(clock: { now: number } | null = null) {
  const [pa, pb] = [await freePort(), await freePort()]
  const a = app('Alice', pa, pb, clock)
  const b = app('Bob', pb, pa, clock)
  a.link.start()
  b.link.start()
  await until(() => a.pairing.state().code !== null && b.pairing.state().code !== null)
  return { a, b }
}

describe('PairingService', () => {
  it('pairs when each side types the code shown on the other screen', async () => {
    const { a, b } = await twoApps()
    const codeA = a.pairing.state().code!
    const codeB = b.pairing.state().code!
    expect(codeA).toMatch(/^[2-9A-Z]{4}-[2-9A-Z]{4}$/)

    await b.pairing.submitCode(codeA.toLowerCase()) // case and dash don't matter
    await until(() => a.pairing.state().theyEnteredMyCode && b.pairing.state().iEnteredTheirCode)
    expect(a.link.peer).toBeNull() // one direction is not enough

    await a.pairing.submitCode(codeB)
    await until(() => a.link.peer !== null && b.link.peer !== null)
    expect(a.pinned()).toBe(b.identity.publicKey)
    expect(b.pinned()).toBe(a.identity.publicKey)
    expect(a.pairing.state().status).toBe('paired')
    expect(a.pairing.state().peerFingerprint).toMatch(/^[0-9A-F]{4}( [0-9A-F]{4}){3}$/)
  })

  it('counts wrong codes down, then replaces the code', async () => {
    const { a, b } = await twoApps()
    const first = a.pairing.state().code
    for (let i = 1; i <= MAX_ATTEMPTS; i++) {
      await b.pairing.submitCode('ZZZZ-ZZZZ')
      await until(() => (b.pairing.state().error ?? '').length > 0 && (i < MAX_ATTEMPTS ? b.pairing.state().error!.includes(`${MAX_ATTEMPTS - i} attempt`) : true))
    }
    await until(() => a.pairing.state().code !== first)
    expect(b.pairing.state().error).toContain('Too many wrong attempts')
    expect(a.pinned()).toBeNull()
    // The old code no longer works.
    await b.pairing.submitCode(first!)
    await until(() => (b.pairing.state().error ?? '').startsWith('Wrong code'))
    expect(a.pairing.state().theyEnteredMyCode).toBe(false)
  })

  it('rejects an expired code', async () => {
    const clock = { now: Date.now() }
    const { a, b } = await twoApps(clock)
    const code = a.pairing.state().code!
    clock.now += CODE_TTL_MS + 1
    await b.pairing.submitCode(code)
    await until(() => (b.pairing.state().error ?? '').startsWith('Wrong code'))
    expect(a.pairing.state().theyEnteredMyCode).toBe(false)
  })

  it('accepts a code sent on the duplicate connection that is being dropped', async () => {
    // Both apps dial each other, so for a moment there are two connections while they agree on
    // one. A code sent in that moment used to be dropped silently, and Verify did nothing.
    const [port, unused] = [await freePort(), await freePort()]
    const a = app('Alice', port, unused)
    a.link.start()
    await until(() => a.link.isListening)
    const peer = new Identity(Identity.generate())
    const id = randomUUID()
    const connect = async (): Promise<WebSocket> => {
      const ws = new WebSocket(`ws://${HOST}:${port}`)
      ws.on('error', () => {})
      cleanups.push(() => ws.terminate())
      await new Promise((r) => ws.once('open', r))
      ws.send(JSON.stringify({ t: 'hello', v: PROTOCOL_VERSION, id, name: 'Bob', app: '0.2.0', features: [], key: peer.publicKey, nonce: randomUUID(), pinned: '' }))
      return ws
    }
    const first = await connect()
    await until(() => a.pairing.state().code !== null)
    first.pause() // doesn't see Alice closing it, like a frame already on its way
    let switches = 0
    a.link.on('pairing', () => switches++)
    await connect() // Alice keeps this newer one and starts closing the first
    await until(() => switches > 0)

    const mac = pairingProof(normalizeCode(a.pairing.state().code!), a.identity.publicKey, peer.publicKey)
    first.send(JSON.stringify({ t: 'pair-proof', mac }))
    await until(() => a.pairing.state().theyEnteredMyCode, 1500)
  })
})
