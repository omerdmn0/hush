import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { CallTracker } from './callTracker'
import { messageNotification, shouldNotify, titleWithUnread, trayTooltip } from './notifyLogic'

describe('notification rules', () => {
  it('notifies only when enabled and the window is not focused', () => {
    expect(shouldNotify(true, false)).toBe(true)
    expect(shouldNotify(true, true)).toBe(false)
    expect(shouldNotify(false, false)).toBe(false)
  })

  it('words single messages, images and bursts', () => {
    expect(messageNotification('Mira', [{ text: 'hi\nthere', hasImage: false }])).toEqual({ title: 'Mira', body: 'hi there' })
    expect(messageNotification('Mira', [{ text: '', hasImage: true }]).body).toBe('Sent an image')
    expect(messageNotification('Mira', [{ text: 'look', hasImage: true }]).body).toBe('Image: look')
    expect(
      messageNotification('Mira', [
        { text: 'one', hasImage: false },
        { text: 'two', hasImage: false },
        { text: 'three', hasImage: false }
      ]).body
    ).toBe('3 new messages — three')
    expect(messageNotification('Mira', [{ text: 'x'.repeat(500), hasImage: false }]).body).toHaveLength(140)
  })

  it('shows unread counts in the title and tray tooltip', () => {
    expect(titleWithUnread(0)).toBe('Hush')
    expect(titleWithUnread(3)).toBe('Hush (3)')
    expect(titleWithUnread(250)).toBe('Hush (99+)')
    expect(trayTooltip('Mira', true, 2)).toBe('Hush — Mira · online · 2 unread')
    expect(trayTooltip(null, false, 0)).toBe('Hush — No one linked yet')
  })
})

describe('CallTracker', () => {
  it('reports a call missed when the caller gives up before we answer', () => {
    const t = new CallTracker()
    const id = randomUUID()
    expect(t.fromPeer({ t: 'call', id, sdp: 'v=0' })).toBe('incoming')
    expect(t.fromPeer({ t: 'call-end', id, reason: 'cancelled' })).toBe('missed')
  })

  it('does not report answered or declined calls as missed', () => {
    const t = new CallTracker()
    const answered = randomUUID()
    t.fromPeer({ t: 'call', id: answered, sdp: 'v=0' })
    t.fromUs({ t: 'call-answer', id: answered, sdp: 'v=0' })
    expect(t.fromPeer({ t: 'call-end', id: answered, reason: 'hangup' })).toBeNull()

    const declined = randomUUID()
    t.fromPeer({ t: 'call', id: declined, sdp: 'v=0' })
    t.fromUs({ t: 'call-end', id: declined, reason: 'declined' })
    expect(t.fromPeer({ t: 'call-end', id: declined, reason: 'timeout' })).toBeNull()
  })

  it('knows which calls are still open, for hanging up on quit', () => {
    const t = new CallTracker()
    const mine = randomUUID()
    const theirs = randomUUID()
    t.fromUs({ t: 'call', id: mine, sdp: 'v=0' })
    t.fromPeer({ t: 'call', id: theirs, sdp: 'v=0' })
    expect(t.openCalls().sort()).toEqual([mine, theirs].sort())
    t.fromUs({ t: 'call-end', id: mine, reason: 'hangup' })
    t.fromPeer({ t: 'call-end', id: theirs, reason: 'hangup' })
    expect(t.openCalls()).toEqual([])
  })
})
