import { describe, expect, it } from 'vitest'
import { applyEvents, isReactionEmoji, reactionData, type EventRecord } from './events'

const ME = 'me'
const PEER = 'peer'
let seq = 0
const ev = (authorId: string, kind: string, data: string | null, sentAt = ++seq): EventRecord => ({ authorId, seq: sentAt, sentAt, kind, data })

describe('applyEvents', () => {
  it('shows the latest edit by the author only', () => {
    const s = applyEvents(ME, [ev(ME, 'edit', 'first fix'), ev(PEER, 'edit', 'forged by the peer'), ev(ME, 'edit', 'second fix')], ME)
    expect(s.text).toBe('second fix')
    expect(s.deleted).toBe(false)
  })

  it('ignores a delete from someone who did not write the message', () => {
    expect(applyEvents(ME, [ev(PEER, 'delete', null)], ME).deleted).toBe(false)
    const s = applyEvents(ME, [ev(PEER, 'react', '+👍'), ev(ME, 'delete', null)], ME)
    expect(s).toEqual({ deleted: true, reactions: [] })
  })

  it('toggles reactions per person, several each, in first-use order', () => {
    const s = applyEvents(
      PEER,
      [ev(ME, 'react', '+🔥'), ev(PEER, 'react', '+😂'), ev(PEER, 'react', '+🔥'), ev(ME, 'react', '+❤️'), ev(ME, 'react', '-🔥'), ev(ME, 'react', '+🔥'), ev(PEER, 'react', '-😂')],
      ME
    )
    expect(s.reactions).toEqual([
      { emoji: '🔥', mine: true, theirs: true },
      { emoji: '❤️', mine: true, theirs: false }
    ])
  })

  it('applies one person’s events in their own order even if clocks disagree', () => {
    // Sent with a clock that went backwards: sequence order still wins within one author.
    const a: EventRecord = { authorId: ME, seq: 1, sentAt: 500, kind: 'react', data: '+👍' }
    const b: EventRecord = { authorId: ME, seq: 2, sentAt: 100, kind: 'react', data: '-👍' }
    expect(applyEvents(PEER, [b, a], ME).reactions).toEqual([])
  })

  it('keeps the newest edit even if the clock went backwards between edits', () => {
    const first: EventRecord = { authorId: ME, seq: 1, sentAt: 500, kind: 'edit', data: 'first' }
    const second: EventRecord = { authorId: ME, seq: 2, sentAt: 100, kind: 'edit', data: 'second' }
    expect(applyEvents(ME, [second, first], ME).text).toBe('second')
  })

  it('an edit can empty a caption', () => {
    const state = applyEvents(ME, [{ authorId: ME, seq: 1, sentAt: 1, kind: 'edit', data: '' }], ME)
    expect(state.text).toBe('')
  })

  it('rejects junk reactions', () => {
    expect(applyEvents(PEER, [ev(ME, 'react', '+hello'), ev(ME, 'react', '+ 👍'), ev(ME, 'react', '👍')], ME).reactions).toEqual([])
    for (const ok of ['👍', '👍🏽', '👨‍👩‍👧', '🇹🇷', '❤️']) expect(isReactionEmoji(ok)).toBe(true)
    expect(reactionData('🔥', false)).toBe('-🔥')
  })
})
