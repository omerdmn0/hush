import { EventEmitter } from 'node:events'
import type { IncomingMessage } from 'node:http'
import WebSocket, { WebSocketServer, type RawData } from 'ws'
import { MAX_FRAME_BYTES, parseFrame, PROTOCOL_VERSION, type Frame } from '../shared/protocol'

/**
 * PeerLink keeps exactly one WebSocket connection to the other Hush app.
 *
 * - Listens on this computer's Tailscale IP and accepts only the configured peer address.
 * - Also dials the peer, so it works even if one side's firewall blocks inbound connections.
 * - If both directions connect at once, both apps deterministically keep the connection dialed
 *   by the smaller install id and close the other.
 * - Heartbeats detect dead connections; dialing retries with exponential backoff.
 *
 * It only moves validated frames; chat logic lives in ChatService.
 */

export interface LinkConfig {
  selfId: string
  name: string
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
}

interface LinkEvents {
  up: [peer: LinkPeer]
  down: []
  frame: [frame: Frame, peer: LinkPeer]
  listening: [listening: boolean, error: string | null]
  problem: [message: string]
}

interface Conn {
  ws: WebSocket
  outgoing: boolean
  peer: LinkPeer | null
  alive: boolean
  helloTimer: ReturnType<typeof setTimeout>
}

const HEARTBEAT_MS = 15_000
const HELLO_TIMEOUT_MS = 5_000
const BACKOFF_MIN_MS = 1_000
const BACKOFF_MAX_MS = 30_000
const RELISTEN_MS = 10_000

const normalize = (addr: string | undefined): string => (addr ?? '').replace(/^::ffff:/, '')

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

  /** The connected peer, or null when offline. */
  get peer(): LinkPeer | null {
    return this.active?.peer ?? null
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

  /** Sends a frame on the active connection. Resolves false if offline or the write failed. */
  send(frame: Frame): Promise<boolean> {
    const c = this.active
    if (!c || c.ws.readyState !== WebSocket.OPEN) return Promise.resolve(false)
    return new Promise((resolve) => c.ws.send(JSON.stringify(frame), (err) => resolve(!err)))
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
      alive: true,
      helloTimer: setTimeout(() => !conn.peer && ws.terminate(), HELLO_TIMEOUT_MS)
    }
    this.conns.add(conn)
    ws.on('error', () => {})
    ws.on('pong', () => (conn.alive = true))
    ws.on('close', () => this.onClose(conn))
    ws.on('message', (data: RawData, isBinary: boolean) => {
      if (isBinary) return
      const frame = parseFrame(data.toString())
      if (!frame) return
      if (!conn.peer) {
        if (frame.t === 'hello') this.onHello(conn, frame)
        else ws.close(4002, 'expected hello')
        return
      }
      if (frame.t === 'hello') return
      if (frame.t === 'profile') conn.peer.name = frame.name
      this.emit('frame', frame, conn.peer)
    })
    ws.send(JSON.stringify({ t: 'hello', v: PROTOCOL_VERSION, id: this.cfg.selfId, name: this.cfg.name } satisfies Frame))
  }

  private onHello(conn: Conn, hello: Extract<Frame, { t: 'hello' }>): void {
    clearTimeout(conn.helloTimer)
    if (hello.v !== PROTOCOL_VERSION) {
      this.emit(
        'problem',
        `The other Hush uses protocol v${hello.v}, this one v${PROTOCOL_VERSION}. Update both apps to the same version.`
      )
      conn.ws.close(4001, 'protocol version mismatch')
      return
    }
    if (hello.id === this.cfg.selfId) {
      conn.ws.close(4003, 'connected to self')
      return
    }
    conn.peer = { id: hello.id, name: hello.name }

    const current = this.active
    if (!current) {
      this.active = conn
      this.backoff = BACKOFF_MIN_MS
      clearTimeout(this.dialTimer)
      this.emit('up', conn.peer)
    } else if (this.prefer(conn, current)) {
      this.active = conn
      current.ws.close(1000, 'duplicate connection')
    } else {
      conn.ws.close(1000, 'duplicate connection')
    }
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
