import { describe, expect, it } from 'vitest'
import { callLogText, candidateAllowed, endedText, formatDuration, offersScreen, outcomeFor, withStereoScreenAudio, yieldToIncoming } from './callLogic'

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

describe('call history', () => {
  it('maps how a call ended to its history outcome', () => {
    expect(outcomeFor('out', 'hangup', true)).toBe('completed')
    expect(outcomeFor('in', 'failed', true)).toBe('completed') // audio dropped after talking
    expect(outcomeFor('in', 'cancelled', false)).toBe('missed')
    expect(outcomeFor('in', 'timeout', false)).toBe('missed')
    expect(outcomeFor('out', 'timeout', false)).toBe('no-answer')
    expect(outcomeFor('out', 'cancelled', false)).toBe('cancelled')
    expect(outcomeFor('in', 'declined', false)).toBe('declined')
    expect(outcomeFor('out', 'busy', false)).toBe('busy')
  })
  it('words entries from this computer’s point of view', () => {
    const base = { id: 'x', startedAt: 0, connectedAt: 1_000, endedAt: 253_000, direction: 'out' as const, outcome: 'completed' as const }
    expect(callLogText(base, 'Mira')).toBe('You called Mira · 04:12')
    expect(callLogText({ ...base, direction: 'in' }, 'Mira')).toBe('Mira called you · 04:12')
    expect(callLogText({ ...base, endedAt: 3_726_000 }, 'Mira')).toBe('You called Mira · 01:02:05')
    expect(callLogText({ ...base, direction: 'in', outcome: 'missed', connectedAt: null }, 'Mira')).toBe('Missed call from Mira')
    expect(callLogText({ ...base, outcome: 'declined', connectedAt: null }, 'Mira')).toBe('Mira declined your call')
    expect(callLogText({ ...base, outcome: 'no-answer', connectedAt: null }, 'Mira')).toBe("Mira didn't answer")
  })
})

describe('screen audio in the SDP', () => {
  const m = (kind: string, fmtp = ''): string => `m=${kind} 9 UDP/TLS/RTP/SAVPF 111\r\na=rtpmap:111 opus/48000/2\r\n${fmtp}`
  const sdp = 'v=0\r\n' + m('audio', 'a=fmtp:111 minptime=10;useinbandfec=1\r\n') + 'm=video 9 UDP/TLS/RTP/SAVPF 96\r\n' + m('audio', 'a=fmtp:111 minptime=10;useinbandfec=1\r\n')

  it('makes only the screen audio line stereo', () => {
    const out = withStereoScreenAudio(sdp)
    expect(out.match(/stereo=1;sprop-stereo=1;maxaveragebitrate=128000\r\n/g)).toHaveLength(1)
    expect(out.split('m=audio')[1]).not.toContain('stereo=1') // the voice stays as it is
    expect(out.split('m=audio')[2]).toContain('useinbandfec=1;stereo=1')
  })

  it('leaves calls without screen slots alone', () => {
    const voice = 'v=0\r\n' + m('audio', 'a=fmtp:111 minptime=10\r\n')
    expect(withStereoScreenAudio(voice)).toBe(voice)
    expect(offersScreen(voice)).toBe(false)
    expect(offersScreen(sdp)).toBe(true)
  })
})
