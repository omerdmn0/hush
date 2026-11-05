import { describe, expect, it } from 'vitest'
import { checkPeerIp, isTailscaleIp, parseIpv4 } from './ip'

describe('parseIpv4', () => {
  it('parses valid addresses and trims whitespace', () => {
    expect(parseIpv4(' 100.101.42.7 ')).toEqual([100, 101, 42, 7])
  })
  it('rejects malformed or out-of-range addresses', () => {
    expect(parseIpv4('100.101.42')).toBeNull()
    expect(parseIpv4('100.101.42.256')).toBeNull()
    expect(parseIpv4('fd7a:115c::1')).toBeNull()
    expect(parseIpv4('abc')).toBeNull()
  })
})

describe('isTailscaleIp', () => {
  it('accepts the 100.64.0.0/10 range boundaries', () => {
    expect(isTailscaleIp('100.64.0.0')).toBe(true)
    expect(isTailscaleIp('100.127.255.255')).toBe(true)
  })
  it('rejects addresses just outside the range and LAN addresses', () => {
    expect(isTailscaleIp('100.63.255.255')).toBe(false)
    expect(isTailscaleIp('100.128.0.0')).toBe(false)
    expect(isTailscaleIp('192.168.1.20')).toBe(false)
  })
})

describe('checkPeerIp', () => {
  it('reports each problem', () => {
    expect(checkPeerIp('', null)).toBe('empty')
    expect(checkPeerIp('hello', null)).toBe('not-ipv4')
    expect(checkPeerIp('192.168.1.5', null)).toBe('not-tailscale')
    expect(checkPeerIp('100.88.14.2', '100.88.14.2')).toBe('is-self')
  })
  it('accepts a valid peer address', () => {
    expect(checkPeerIp('100.101.42.7', '100.88.14.2')).toBeNull()
  })
})
