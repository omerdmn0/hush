import { describe, expect, it } from 'vitest'
import { candidateAllowed, endedText, formatDuration, yieldToIncoming } from './callLogic'

const cand = (addr: string, type = 'host'): string => `candidate:842163049 1 udp 1677729535 ${addr} 50404 typ ${type} generation 0`

describe('candidateAllowed', () => {
  it('keeps only Tailscale addresses in normal use', () => {
    expect(candidateAllowed(cand('100.101.42.7'), false)).toBe(true)
    expect(candidateAllowed(cand('192.168.1.20'), false)).toBe(false)
    expect(candidateAllowed(cand('fd7a:115c:a1e0::1'), false)).toBe(false)
    expect(candidateAllowed(cand('4b2c2f2e-ab12.local'), false)).toBe(false) // mDNS-obfuscated
    expect(candidateAllowed(cand('203.0.113.5', 'srflx'), false)).toBe(false)
    expect(candidateAllowed('', false)).toBe(true)
  })
  it('allows anything in dev pairing mode', () => {
    expect(candidateAllowed(cand('192.168.1.20'), true)).toBe(true)
  })
})

describe('yieldToIncoming', () => {
  it('lets both sides agree on the same surviving call', () => {
    const a = '1111aaaa-0000-4000-8000-000000000000'
    const b = '2222bbbb-0000-4000-8000-000000000000'
    expect(yieldToIncoming(b, a)).toBe(true) // B yields to A's call
    expect(yieldToIncoming(a, b)).toBe(false) // A keeps its own
  })
})

describe('endedText', () => {
  it('describes each ending from the right point of view', () => {
    expect(endedText('hangup', 'peer', 'Mira', 763_000)).toBe('Call ended · 00:12:43')
    expect(endedText('declined', 'peer', 'Mira', null)).toBe('Mira declined')
    expect(endedText('declined', 'me', 'Mira', null)).toBe('Call declined')
    expect(endedText('timeout', 'me', 'Mira', null)).toBe('No answer')
    expect(endedText('cancelled', 'peer', 'Mira', null)).toBe('Missed call from Mira')
    expect(endedText('busy', 'peer', 'Mira', null)).toBe('Mira is busy')
  })
  it('formats durations', () => {
    expect(formatDuration(0)).toBe('00:00:00')
    expect(formatDuration(3_725_400)).toBe('01:02:05')
  })
})
