import { EventEmitter } from 'node:events'
import type { IncomingMessage } from 'node:http'
import WebSocket, { WebSocketServer, type RawData } from 'ws'
import { FEATURES, MAX_FRAME_BYTES, MIN_PROTOCOL, parseFrame, PROTOCOL_VERSION, type Frame } from '../shared/protocol'
import { newNonce, verifyAuth } from './identity'

/**
 * PeerLink keeps exactly one WebSocket connection to the other Hush app.
 *
 * - Listens on this computer's Tailscale IP and accepts only the configured peer address.
 * - Also dials the peer, so it works even if one side's firewall blocks inbound connections.
 * - If both directions connect at once, both apps deterministically keep the connection dialed
 *   by the smaller install id and close the other.
 * - Heartbeats detect dead connections; dialing retries with exponential backoff.
 * - 'up' fires whenever the active connection changes (first connect, or a switch to the
 *   surviving duplicate), so the chat layer can re-sync anything cut off mid-switch.
 * - Identity: a connection only counts as up once the other side proved (by signature) the key
 *   pinned at pairing, and has pinned ours. Until then only pairing frames pass ('pairing').
 *
 * It only moves validated frames; chat logic lives in ChatService.
 */

export interface LinkConfig {
  selfId: string
  name: string
  appVersion: string
  identity: {
    publicKey: string
    authSignature: (peerNonce: string, peerKey: string) => string
  }
  /** The other person's key from pairing, or null if not paired. */
  pinned: () => string | null
  /** Address to listen on (own Tailscale IP); null = don't listen. */
  bindHost: string | null
  port: number
  /** Address of the other app; null = not configured. */
  peerHost: string | null
  peerPort: number
}

export interface LinkPeer {
  id: string
  name: string
  /** Their identity key (base64url). */
  key: string
  app: string
  features: string[]
}

interface LinkEvents {
  /** A (new) active connection is ready. May fire again without 'down' when it switches. */
  up: [peer: LinkPeer]
  down: []
  frame: [frame: Frame, peer: LinkPeer]
  /** Binary frame (image chunk) from an authenticated peer. */
  binary: [data: Uint8Array, peer: LinkPeer]
  /** Reachable but not paired (or one side forgot the pairing): pairing frames may flow. */
  pairing: [peer: LinkPeer]
  /** pair-proof / pair-result from the peer we are pairing with. */
  'pair-frame': [frame: Extract<Frame, { t: 'pair-proof' | 'pair-result' }>, peer: LinkPeer]
  /** The device at the peer address has a different key than the one we paired with. */
  'identity-mismatch': [peer: LinkPeer]
  listening: [listening: boolean, error: string | null]
  problem: [message: string]
}

interface Conn {
  ws: WebSocket
  outgoing: boolean
  peer: LinkPeer | null
  /** Which key the peer has pinned ('' = none), from its hello. */
  peerPinned: string
  alive: boolean
  helloTimer: ReturnType<typeof setTimeout>
  /** Our challenge for this connection (sent in hello). */
  nonce: string
  /** Their challenge (from their hello), which our auth signature covers. */
  peerNonce: string
  sentAuth: boolean
  /** The peer's auth signature, kept until we can check it against a pinned key. */
  peerAuthSig: string | null
  authed: boolean
}

const HEARTBEAT_MS = 15_000
const HELLO_TIMEOUT_MS = 5_000
const BACKOFF_MIN_MS = 1_000
const BACKOFF_MAX_MS = 30_000
const RELISTEN_MS = 10_000

const normalize = (addr: string | undefined): string => (addr ?? '').replace(/^::ffff:/, '')
const toBytes = (d: RawData): Uint8Array => (Array.isArray(d) ? Buffer.concat(d) : d instanceof ArrayBuffer ? new Uint8Array(d) : d)

export class PeerLink extends EventEmitter<LinkEvents> {
  private cfg: LinkConfig
  private server: WebSocketServer | null = null
  private listening = false
  private conns = new Set<Conn>()
  private active: Conn | null = null
  private dialing: WebSocket | null = null
  private dialTimer: ReturnType<typeof setTimeout> | undefined
  private relistenTimer: ReturnType<typeof setTimeout> | undefined
  private heartbeat: ReturnType<typeof setInterval> | undefined
  private backoff = BACKOFF_MIN_MS
  private stopped = true

  constructor(cfg: LinkConfig) {
    super()
    this.cfg = { ...cfg }
  }

  /** The connected, authenticated peer, or null. */
  get peer(): LinkPeer | null {
    return this.active?.authed ? this.active.peer : null
  }

  /**
   * Pairing just finished: we pinned their key. Pairing only completes once *both* codes were
   * confirmed, so the other side pins ours at the same point — their earlier hello (sent before
   * pairing) is out of date. Re-check identity on the current connection.
   */
  reauth(): void {
    const c = this.active
    if (!c || c.authed) return
    c.peerPinned = this.cfg.identity.publicKey
    this.beginAuth(c)
  }

  /** Drops all connections and reconnects (e.g. after forgetting a pairing). */
  reset(): void {
    if (this.stopped) return
    const wasUp = this.active !== null
    for (const c of this.conns) c.ws.terminate()
    this.conns.clear()
    this.active = null
    if (wasUp) this.emit('down')
    this.backoff = BACKOFF_MIN_MS
    this.scheduleDial(0)
  }

  /** Sends a pairing frame to the reachable-but-unauthenticated peer. */
  sendPairing(frame: Extract<Frame, { t: 'pair-proof' | 'pair-result' }>): Promise<boolean> {
    const c = this.active
    if (!c?.peer || c.authed || c.ws.readyState !== WebSocket.OPEN) return Promise.resolve(false)
    return new Promise((resolve) => c.ws.send(JSON.stringify(frame), (err) => resolve(!err)))
  }

  get isListening(): boolean {
    return this.listening
  }

  start(): void {
    if (!this.stopped) return
    this.stopped = false
    this.listen()
    this.scheduleDial(0)
    this.heartbeat = setInterval(() => this.beat(), HEARTBEAT_MS)
  }

  async stop(): Promise<void> {
    this.stopped = true
    clearInterval(this.heartbeat)
    clearTimeout(this.dialTimer)
    clearTimeout(this.relistenTimer)
    this.dialing?.terminate()
    this.dialing = null
    for (const c of this.conns) c.ws.terminate()
    this.conns.clear()
    this.active = null
    await this.closeServer()
  }

  /** Applies changed settings, restarting only the parts that are affected. */
  update(patch: Partial<Omit<LinkConfig, 'selfId'>>): void {
    const prev = this.cfg
    this.cfg = { ...prev, ...patch }
    if (this.stopped) return

    if (patch.name !== undefined && patch.name !== prev.name) this.send({ t: 'profile', name: this.cfg.name })

    if (this.cfg.bindHost !== prev.bindHost || this.cfg.port !== prev.port) {
      void this.closeServer().then(() => this.listen())
    }
    if (this.cfg.peerHost !== prev.peerHost || this.cfg.peerPort !== prev.peerPort) {
      // Different person/computer: drop everything and start over.
      const wasUp = this.active !== null
      this.dialing?.terminate()
      this.dialing = null
      for (const c of this.conns) c.ws.terminate()
      this.conns.clear()
      this.active = null
      if (wasUp) this.emit('down')
      this.backoff = BACKOFF_MIN_MS
      this.scheduleDial(0)
    }
  }

  /** Retry listening and dialing right away (e.g. user pressed "Retry"). */
  reconnectNow(): void {
    if (this.stopped) return
    this.backoff = BACKOFF_MIN_MS
    if (!this.listening) {
      clearTimeout(this.relistenTimer)
      void this.closeServer().then(() => this.listen())
    }
    this.scheduleDial(0)
  }

  /**
   * Sends a frame on the active connection — or, while a duplicate is being closed, on the
   * other open one. Resolves false if offline or the write failed.
   */
  send(frame: Frame): Promise<boolean> {
    return this.write(JSON.stringify(frame))
  }

  /** Sends a binary frame (image chunk); same delivery rules as send(). */
  sendBinary(data: Uint8Array): Promise<boolean> {
    return this.write(data)
  }

  private write(payload: string | Uint8Array): Promise<boolean> {
    const open = (c: Conn | null): c is Conn => c !== null && c.authed && c.ws.readyState === WebSocket.OPEN
    const c = open(this.active) ? this.active : ([...this.conns].find(open) ?? null)
    if (!c) return Promise.resolve(false)
    return new Promise((resolve) => c.ws.send(payload, { binary: typeof payload !== 'string' }, (err) => resolve(!err)))
  }

  // ---------- listening ----------

  private listen(): void {
    if (this.stopped || this.server) return
    const host = this.cfg.bindHost
    if (!host) {
      this.setListening(false, null)
      return
    }
    const server = new WebSocketServer({
      host,
      port: this.cfg.port,
      maxPayload: MAX_FRAME_BYTES,
      // Only the configured peer may connect at all.
      verifyClient: ({ req }: { req: IncomingMessage }) => this.cfg.peerHost !== null && normalize(req.socket.remoteAddress) === this.cfg.peerHost
    })
    this.server = server
    server.on('listening', () => this.setListening(true, null))
    server.on('connection', (ws) => this.adopt(ws, false))
    server.on('error', (err: NodeJS.ErrnoException) => {
      const msg =
        err.code === 'EADDRINUSE'
          ? `Port ${this.cfg.port} is already in use — is another copy of Hush running?`
          : err.code === 'EADDRNOTAVAIL'
            ? `Can't listen on ${host}. Is Tailscale connected?`
            : `Can't accept connections: ${err.message}`
      this.setListening(false, msg)
      void this.closeServer()
      this.relistenTimer = setTimeout(() => this.listen(), RELISTEN_MS)
    })
  }

  private closeServer(): Promise<void> {
    const s = this.server
    this.server = null
    if (!s) return Promise.resolve()
    if (this.listening) this.setListening(false, null)
    // Only closes the listener; established connections stay up.
    return new Promise((resolve) => s.close(() => resolve()))
  }

  private setListening(listening: boolean, error: string | null): void {
    this.listening = listening
    this.emit('listening', listening, error)
  }

  // ---------- dialing ----------

  private scheduleDial(delay: number): void {
    clearTimeout(this.dialTimer)
    if (this.stopped || !this.cfg.peerHost || this.active) return
    this.dialTimer = setTimeout(() => this.dial(), delay)
  }

  private dial(): void {
    if (this.stopped || !this.cfg.peerHost || this.active || this.dialing) return
    const ws = new WebSocket(`ws://${this.cfg.peerHost}:${this.cfg.peerPort}`, {
      maxPayload: MAX_FRAME_BYTES,
      handshakeTimeout: 5_000
    })
    this.dialing = ws
    ws.on('error', () => {}) // reported through 'close'
    ws.once('open', () => {
      if (this.dialing === ws) this.dialing = null
      this.adopt(ws, true)
    })
    ws.once('close', () => {
      if (this.dialing !== ws) return // already adopted; Conn handles it
      this.dialing = null
      this.retryLater()
    })
  }

  private retryLater(): void {
    const jitter = 0.8 + Math.random() * 0.4
    this.scheduleDial(this.backoff * jitter)
    this.backoff = Math.min(this.backoff * 2, BACKOFF_MAX_MS)
  }

  // ---------- connections ----------

  private adopt(ws: WebSocket, outgoing: boolean): void {
    if (this.stopped) {
      ws.terminate()
      return
    }
    const conn: Conn = {
      ws,
      outgoing,
      peer: null,
      peerPinned: '',
      alive: true,
      helloTimer: setTimeout(() => !conn.peer && ws.terminate(), HELLO_TIMEOUT_MS),
      nonce: newNonce(),
      peerNonce: '',
      sentAuth: false,
      peerAuthSig: null,
      authed: false
    }
    this.conns.add(conn)
    ws.on('error', () => {})
    ws.on('pong', () => (conn.alive = true))
    ws.on('close', () => this.onClose(conn))
    ws.on('message', (data: RawData, isBinary: boolean) => {
      if (isBinary) {
        if (conn.authed && conn.peer) this.emit('binary', toBytes(data), conn.peer)
        return
      }
      const frame = parseFrame(data.toString()) // unknown frame types (newer Hush) → null → ignored
      if (!frame) return
      if (!conn.peer) {
        if (frame.t === 'hello') this.onHello(conn, frame)
        else ws.close(4002, 'expected hello')
        return
      }
      switch (frame.t) {
        case 'hello':
          return
        case 'auth':
          conn.peerAuthSig = frame.sig
          if (this.active === conn) this.beginAuth(conn)
          return
        case 'pair-proof':
        case 'pair-result':
          if (this.active === conn && !conn.authed) this.emit('pair-frame', frame, conn.peer)
          return
      }
      if (!conn.authed) return // nothing else before identity is proven
      if (frame.t === 'profile') conn.peer.name = frame.name
      this.emit('frame', frame, conn.peer)
    })
    ws.send(
      JSON.stringify({
        t: 'hello',
        v: PROTOCOL_VERSION,
        id: this.cfg.selfId,
        name: this.cfg.name,
        app: this.cfg.appVersion,
        features: [...FEATURES],
        key: this.cfg.identity.publicKey,
        nonce: conn.nonce,
        pinned: this.cfg.pinned() ?? ''
      } satisfies Frame)
    )
  }

  private onHello(conn: Conn, hello: Extract<Frame, { t: 'hello' }>): void {
    clearTimeout(conn.helloTimer)
    if (hello.v < MIN_PROTOCOL) {
      this.emit('problem', `The other Hush is too old (protocol v${hello.v}). Update it to the latest version.`)
      conn.ws.close(4001, 'protocol too old')
      return
    }
    if (hello.id === this.cfg.selfId) {
      conn.ws.close(4003, 'connected to self')
      return
    }
    conn.peer = { id: hello.id, name: hello.name, key: hello.key, app: hello.app, features: hello.features }
    conn.peerPinned = hello.pinned
    conn.peerNonce = hello.nonce

    const current = this.active
    if (!current) {
      this.active = conn
      this.backoff = BACKOFF_MIN_MS
      clearTimeout(this.dialTimer)
      this.beginAuth(conn)
    } else if (this.prefer(conn, current)) {
      this.active = conn
      current.ws.close(1000, 'duplicate connection')
      this.beginAuth(conn)
    } else {
      conn.ws.close(1000, 'duplicate connection')
    }
  }

  /**
   * Identity check on the active connection:
   * - neither side paired with the other → 'pairing'
   * - we pinned a different key → 'identity-mismatch' (refused)
   * - both pinned each other → exchange signatures; 'up' once theirs verifies.
   */
  private beginAuth(conn: Conn): void {
    const peer = conn.peer!
    const pinned = this.cfg.pinned()
    if (pinned && pinned !== peer.key) {
      this.emit('identity-mismatch', peer)
      conn.ws.close(4004, 'identity mismatch')
      return
    }
    if (!pinned || conn.peerPinned !== this.cfg.identity.publicKey) {
      this.emit('pairing', peer)
      return
    }
    if (!conn.sentAuth) {
      conn.sentAuth = true
      conn.ws.send(JSON.stringify({ t: 'auth', sig: this.cfg.identity.authSignature(conn.peerNonce, peer.key) } satisfies Frame))
    }
    if (conn.authed || !conn.peerAuthSig) return
    if (!verifyAuth(conn.peerAuthSig, conn.nonce, pinned, this.cfg.identity.publicKey)) {
      this.emit('identity-mismatch', peer)
      conn.ws.close(4005, 'bad identity proof')
      return
    }
    conn.authed = true
    this.emit('up', peer)
  }

  /** Both apps run the same rule, so they keep the same one of two simultaneous connections. */
  private prefer(candidate: Conn, current: Conn): boolean {
    const dialer = (c: Conn): string => (c.outgoing ? this.cfg.selfId : c.peer!.id)
    const a = dialer(candidate)
    const b = dialer(current)
    return a === b ? true /* same side reconnected: newest wins */ : a < b
  }

  private onClose(conn: Conn): void {
    clearTimeout(conn.helloTimer)
    this.conns.delete(conn)
    if (this.active !== conn) return
    const fallback = [...this.conns].find((c) => c.peer !== null && c.ws.readyState === WebSocket.OPEN)
    if (fallback) {
      this.active = fallback
      if (fallback.authed) this.emit('up', fallback.peer!)
      else this.beginAuth(fallback)
      return
    }
    this.active = null
    this.emit('down')
    if (!this.stopped) this.scheduleDial(250)
  }

  private beat(): void {
    for (const c of this.conns) {
      if (!c.peer) continue
      if (!c.alive) {
        c.ws.terminate()
        continue
      }
      c.alive = false
      c.ws.ping()
    }
  }
}
