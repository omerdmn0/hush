import { describe, expect, it } from 'vitest'
import { CallTracker } from './callTracker'
import type { CallSignal } from '../shared/protocol'

const signal = (t: CallSignal['t'], id: string): CallSignal => ({ t, id, sdp: 'x', reason: 'hangup' }) as unknown as CallSignal

describe('CallTracker', () => {
  it('forgets a call that was still ringing when the link dropped', () => {
    const outgoing = new CallTracker()
    outgoing.fromUs(signal('call', 'a'))
    outgoing.linkDown()
    expect(outgoing.openCalls()).toEqual([])

    const incoming = new CallTracker()
    expect(incoming.fromPeer(signal('call', 'b'))).toBe('incoming')
    incoming.linkDown()
    expect(incoming.openCalls()).toEqual([])
  })

  it('keeps an answered call when the link drops, until it ends', () => {
    const caller = new CallTracker()
    caller.fromUs(signal('call', 'a'))
    caller.fromPeer(signal('call-answer', 'a'))
    caller.linkDown()
    expect(caller.openCalls()).toEqual(['a'])
    caller.fromUs(signal('call-end', 'a'))
    expect(caller.openCalls()).toEqual([])

    const callee = new CallTracker()
    callee.fromPeer(signal('call', 'b'))
    callee.fromUs(signal('call-answer', 'b'))
    callee.linkDown()
    expect(callee.openCalls()).toEqual(['b'])
    callee.fromPeer(signal('call-end', 'b'))
    expect(callee.openCalls()).toEqual([])
  })

  it('still reports a call cancelled before it was answered as missed', () => {
    const t = new CallTracker()
    t.fromPeer(signal('call', 'a'))
    expect(t.fromPeer({ ...signal('call-end', 'a'), reason: 'cancelled' } as CallSignal)).toBe('missed')
  })
})
