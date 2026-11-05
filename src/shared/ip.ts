// Tailscale assigns IPv4 addresses from the CGNAT range 100.64.0.0/10
// (100.64.0.0 – 100.127.255.255).

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/

export function parseIpv4(value: string): [number, number, number, number] | null {
  const m = IPV4.exec(value.trim())
  if (!m) return null
  const parts = m.slice(1).map(Number) as [number, number, number, number]
  return parts.every((n) => n >= 0 && n <= 255) ? parts : null
}

export function isTailscaleIp(value: string): boolean {
  const p = parseIpv4(value)
  return p !== null && p[0] === 100 && p[1] >= 64 && p[1] <= 127
}

export type PeerIpProblem = 'empty' | 'not-ipv4' | 'not-tailscale' | 'is-self'

/** Validates the peer IP typed in settings. Returns null when valid. */
export function checkPeerIp(value: string, ownIp: string | null): PeerIpProblem | null {
  const v = value.trim()
  if (v === '') return 'empty'
  if (!parseIpv4(v)) return 'not-ipv4'
  if (!isTailscaleIp(v)) return 'not-tailscale'
  if (ownIp !== null && v === ownIp) return 'is-self'
  return null
}
