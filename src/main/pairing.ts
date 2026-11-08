import { EventEmitter } from 'node:events'
import type { Frame } from '../shared/protocol'
import type { PairingState } from '../shared/types'
import { fingerprint, formatCode, newPairingCode, normalizeCode, pairingProof, proofMatches, CODE_LENGTH } from './identity'
import type { LinkPeer, PeerLink } from './link'

export const CODE_TTL_MS = 10 * 60_000
export const MAX_ATTEMPTS = 5

interface PinStore {
  getPinned: () => string | null
  setPinned: (key: string | null) => void
}

/**
 * Two-way pairing: each app shows a one-time code; the other person types it in. Both must
 * succeed before either side pins the other's key. 5 wrong tries or 10 minutes → new code.
 */
export class PairingService extends EventEmitter<{ change: [PairingState] }> {
  private peer: LinkPeer | null = null
  private code: string | null = null
  private codeExpiresAt: number | null = null
  private failed = 0
  private theyEnteredMyCode = false
  private iEnteredTheirCode = false
  private mismatch: LinkPeer | null = null
  private error: string | null = null
  private expiryTimer: ReturnType<typeof setTimeout> | undefined

  constructor(
    private readonly link: PeerLink,
    private readonly myKey: string,
    private readonly pins: PinStore,
    private readonly now: () => number = Date.now
  ) {
    super()
    link.on('pairing', (peer) => this.onPairing(peer))
    link.on('identity-mismatch', (peer) => {
      this.mismatch = peer
      this.publish()
    })
    link.on('up', () => {
      this.mismatch = null
      this.peer = null
      this.code = null
      this.publish()
    })
    link.on('down', () => {
      this.peer = null
      this.theyEnteredMyCode = false
      this.iEnteredTheirCode = false
      this.publish()
    })
    link.on('pair-frame', (frame, peer) => void this.onFrame(frame, peer))
  }

  dispose(): void {
    clearTimeout(this.expiryTimer)
  }

  state(): PairingState {
    const pinned = this.pins.getPinned()
    return {
      status: this.mismatch ? 'mismatch' : pinned && !this.peer ? 'paired' : 'unpaired',
      peerReachable: this.peer !== null,
      code: this.peer && this.code ? formatCode(this.code) : null,
      codeExpiresAt: this.peer ? this.codeExpiresAt : null,
      theyEnteredMyCode: this.theyEnteredMyCode,
      iEnteredTheirCode: this.iEnteredTheirCode,
      error: this.error,
      myFingerprint: fingerprint(this.myKey),
      peerFingerprint: pinned ? fingerprint(pinned) : this.peer ? fingerprint(this.peer.key) : null,
      peerName: this.peer?.name ?? null
    }
  }

  /** The user typed the code shown on the other screen. */
  async submitCode(input: string): Promise<void> {
    const code = normalizeCode(input)
    if (!this.peer) {
      this.error = 'The other app isn’t reachable right now.'
    } else if (code.length !== CODE_LENGTH) {
      this.error = `The code has ${CODE_LENGTH} characters.`
    } else {
      this.error = null
      const sent = await this.link.sendPairing({ t: 'pair-proof', mac: pairingProof(code, this.peer.key, this.myKey) })
      if (!sent) this.error = 'That didn’t reach the other app — try again.'
    }
    this.publish()
  }

  /** Unpair (also used for "pair again" after an identity change). */
  forget(): void {
    this.pins.setPinned(null)
    this.mismatch = null
    this.theyEnteredMyCode = false
    this.iEnteredTheirCode = false
    this.error = null
    this.publish()
    this.link.reset()
  }

  private onPairing(peer: LinkPeer): void {
    const samePeer = this.peer?.key === peer.key
    this.peer = peer
    this.mismatch = null
    if (!samePeer) {
      this.theyEnteredMyCode = false
      this.iEnteredTheirCode = false
      this.error = null
    }
    if (!this.code || (this.codeExpiresAt !== null && this.now() > this.codeExpiresAt)) this.newCode()
    this.publish()
  }

  private async onFrame(frame: Extract<Frame, { t: 'pair-proof' | 'pair-result' }>, peer: LinkPeer): Promise<void> {
    if (!this.peer || peer.key !== this.peer.key) return
    if (frame.t === 'pair-proof') {
      const valid = this.code !== null && this.codeExpiresAt !== null && this.now() <= this.codeExpiresAt
      if (valid && proofMatches(frame.mac, this.code!, this.myKey, peer.key)) {
        this.theyEnteredMyCode = true
        await this.link.sendPairing({ t: 'pair-result', ok: true, attemptsLeft: MAX_ATTEMPTS - this.failed })
        this.maybeComplete()
      } else {
        this.failed++
        const left = Math.max(0, MAX_ATTEMPTS - this.failed)
        if (left === 0) {
          this.newCode()
          this.error = `${peer.name} typed a wrong code too many times — a new code is shown.`
        }
        await this.link.sendPairing({ t: 'pair-result', ok: false, attemptsLeft: left })
      }
    } else if (frame.ok) {
      this.iEnteredTheirCode = true
      this.error = null
      this.maybeComplete()
    } else {
      this.error =
        frame.attemptsLeft > 0
          ? `Wrong code — ${frame.attemptsLeft} attempt${frame.attemptsLeft === 1 ? '' : 's'} left.`
          : `Too many wrong attempts — ${peer.name}'s screen now shows a new code.`
    }
    this.publish()
  }

  private maybeComplete(): void {
    if (!this.peer || !this.theyEnteredMyCode || !this.iEnteredTheirCode) return
    this.pins.setPinned(this.peer.key)
    this.code = null
    this.codeExpiresAt = null
    this.link.reauth()
  }

  private newCode(): void {
    this.code = newPairingCode()
    this.codeExpiresAt = this.now() + CODE_TTL_MS
    this.failed = 0
    // Codes expire; a fresh one appears while the pairing screen is up.
    clearTimeout(this.expiryTimer)
    this.expiryTimer = setTimeout(() => this.onCodeExpired(), CODE_TTL_MS + 1000)
  }

  private onCodeExpired(): void {
    if (this.peer && this.codeExpiresAt !== null && this.now() > this.codeExpiresAt) {
      this.newCode()
      this.error = 'The code expired — a new one is shown.'
      this.publish()
    }
  }

  private publish(): void {
    this.emit('change', this.state())
  }
}
