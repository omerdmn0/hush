import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '../../../shared/types'
import { dayLabel, initial } from './format'
import { buildTimeline, GROUP_WINDOW_MS, lastQueuedId } from './timeline'

const at = (y: number, mo: number, d: number, h: number, mi: number, s = 0, ms = 0): number =>
  new Date(y, mo - 1, d, h, mi, s, ms).getTime()

let n = 0
const msg = (from: ChatMessage['from'], sentAt: number, status: ChatMessage['status'] = 'read'): ChatMessage => ({
  id: `m${String(++n).padStart(3, '0')}`,
  from,
  text: 'x',
  sentAt,
  status
})

const NOW = at(2026, 11, 5, 18, 0)

describe('buildTimeline', () => {
  it('groups consecutive messages from the same sender', () => {
    const items = buildTimeline([msg('peer', at(2026, 11, 5, 9, 0)), msg('peer', at(2026, 11, 5, 9, 1)), msg('me', at(2026, 11, 5, 9, 2))], NOW)
    expect(items.map((i) => i.kind)).toEqual(['day', 'group', 'group'])
    const [, a, b] = items
    expect(a.kind === 'group' && a.messages.length).toBe(2)
    expect(b.kind === 'group' && b.from).toBe('me')
  })

  it('keeps a gap of exactly five minutes in the group and splits one millisecond later', () => {
    const t = at(2026, 11, 5, 10, 0)
    const same = buildTimeline([msg('me', t), msg('me', t + GROUP_WINDOW_MS)], NOW)
    expect(same.filter((i) => i.kind === 'group')).toHaveLength(1)
    const split = buildTimeline([msg('me', t), msg('me', t + GROUP_WINDOW_MS + 1)], NOW)
    expect(split.filter((i) => i.kind === 'group')).toHaveLength(2)
  })

  it('measures the window from the previous message, so a long run stays one group', () => {
    const t = at(2026, 11, 5, 11, 0)
    const run = [0, 4, 8, 12].map((min) => msg('peer', t + min * 60_000))
    expect(buildTimeline(run, NOW).filter((i) => i.kind === 'group')).toHaveLength(1)
  })

  it('starts a new day separator and group at midnight even within five minutes', () => {
    const items = buildTimeline([msg('me', at(2026, 11, 4, 23, 59)), msg('me', at(2026, 11, 5, 0, 1))], NOW)
    expect(items.map((i) => (i.kind === 'day' ? i.label : 'group'))).toEqual(['Yesterday', 'group', 'Today', 'group'])
  })

  it('sorts out-of-order input by time', () => {
    const late = msg('me', at(2026, 11, 5, 12, 0))
    const early = msg('peer', at(2026, 11, 5, 8, 0))
    const groups = buildTimeline([late, early], NOW).filter((i) => i.kind === 'group')
    expect(groups.map((g) => g.kind === 'group' && g.messages[0].id)).toEqual([early.id, late.id])
  })

  it('returns nothing for an empty history', () => {
    expect(buildTimeline([], NOW)).toEqual([])
  })
})

describe('dayLabel', () => {
  it('uses Today, Yesterday, then weekday + date', () => {
    expect(dayLabel(at(2026, 11, 5, 0, 0), NOW)).toBe('Today')
    expect(dayLabel(at(2026, 11, 4, 23, 59), NOW)).toBe('Yesterday')
    expect(dayLabel(at(2026, 11, 3, 21, 4), NOW)).toBe('Tue 03.11.2026')
  })
})

describe('lastQueuedId', () => {
  it('returns the newest queued message of mine, ignoring the peer and delivered ones', () => {
    const a = msg('me', at(2026, 11, 5, 13, 15), 'queued')
    const b = msg('me', at(2026, 11, 5, 13, 16), 'queued')
    const c = msg('me', at(2026, 11, 5, 13, 17), 'delivered')
    expect(lastQueuedId([a, b, c, msg('peer', at(2026, 11, 5, 13, 18))])).toBe(b.id)
    expect(lastQueuedId([c])).toBeNull()
  })
})

describe('initial', () => {
  it('takes the first character, upper-cased', () => {
    expect(initial('mira')).toBe('M')
    expect(initial('  Ömer')).toBe('Ö')
    expect(initial('')).toBe('?')
  })
})
