import { networkInterfaces } from 'node:os'
import { isTailscaleIp } from '../shared/ip'

/** Finds this computer's Tailscale IPv4 address by scanning network interfaces. */
export function findTailscaleIp(): string | null {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal && isTailscaleIp(a.address)) return a.address
    }
  }
  return null
}
