// Pure call decisions (unit-tested); the WebRTC plumbing lives in call.ts.
import { isTailscaleIp } from '../../../shared/ip'
import type { CallEndReason } from '../../../shared/protocol'

/** Ring for this long before giving up ("No answer"). */
export const RING_TIMEOUT_MS = 45_000
/** If audio drops ("disconnected") and doesn't recover within this time, the call ends. */
export const RECONNECT_GRACE_MS = 10_000
/** How long the "Call ended" status stays visible. */
export const ENDED_VISIBLE_MS = 3_500

/**
 * Only use network paths over Tailscale, so call audio never leaves the private network
 * (and LAN addresses aren't shared). `anyNetwork` is the dev two-copies-on-one-machine mode.
 * The candidate line format is: "candidate:<foundation> <component> <proto> <priority> <address> <port> typ <type> …"
 */
export function candidateAllowed(candidate: string, anyNetwork: boolean): boolean {
  if (candidate === '') return true // end-of-candidates marker
  if (anyNetwork) return true
  const address = candidate.split(' ')[4] ?? ''
  return isTailscaleIp(address)
}

/**
 * Both pressed "Call" at the same moment: both apps keep the call with the smaller id, so the
 * two invitations merge into one call instead of both sides seeing "busy".
 * Returns true if we should drop our own outgoing call and take theirs.
 */
export function yieldToIncoming(myCallId: string, theirCallId: string): boolean {
  return theirCallId < myCallId
}

export type EndedBy = 'me' | 'peer' | 'system'

/** Status line shown when a call ends. */
export function endedText(reason: CallEndReason | 'offline' | 'mic' | 'lost', by: EndedBy, peerName: string, durationMs: number | null): string {
  const duration = durationMs !== null ? ` · ${formatDuration(durationMs)}` : ''
  switch (reason) {
    case 'hangup':
      return `Call ended${duration}`
    case 'declined':
      return by === 'me' ? 'Call declined' : `${peerName} declined`
    case 'busy':
      return `${peerName} is busy`
    case 'cancelled':
      return by === 'me' ? 'Call cancelled' : `Missed call from ${peerName}`
    case 'timeout':
      return by === 'me' ? 'No answer' : `Missed call from ${peerName}`
    case 'failed':
      return `Couldn’t connect audio${duration}`
    case 'lost':
      return `Connection lost${duration}`
    case 'offline':
      return `${peerName} is offline`
    case 'mic':
      return 'Can’t use your microphone'
  }
}

/** 00:12:43 */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  return [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60].map((n) => String(n).padStart(2, '0')).join(':')
}
