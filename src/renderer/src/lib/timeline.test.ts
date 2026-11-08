import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '../../../shared/types'
import { dayLabel, initial } from './format'
import { buildTimeline, GROUP_WINDOW_MS, lastQueuedId, reuseGroups } from './timeline'
import { insertSorted } from './useHush'

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

  it('places a delivery notice by time and breaks the group around it', () => {
    const t = at(2026, 11, 5, 13, 15)
    const items = buildTimeline([msg('me', t, 'delivered'), msg('me', t + 60_000, 'delivered')], NOW, [
      { id: 'n1', at: t + 30_000, count: 1 }
    ])
    expect(items.map((i) => i.kind)).toEqual(['day', 'group', 'notice', 'group'])
  })

  it('places call-history entries by start time and breaks groups around them', () => {
    const t = at(2026, 11, 5, 20, 0)
    const items = buildTimeline([msg('me', t), msg('me', t + 120_000)], NOW, [], [
      { id: 'c1', direction: 'out', startedAt: t + 60_000, connectedAt: t + 65_000, endedAt: t + 90_000, outcome: 'completed' }
    ])
    expect(items.map((i) => i.kind)).toEqual(['day', 'group', 'call', 'group'])
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

describe('insertSorted', () => {
  const t = at(2026, 11, 5, 12, 0)
  const [m1, m2, m3] = [msg('me', t), msg('peer', t + 1000), msg('me', t + 2000)]
  it('appends new messages and places synced ones by time, ignoring duplicates', () => {
    expect(insertSorted([m1, m3], m2, false).map((m) => m.id)).toEqual([m1.id, m2.id, m3.id])
    expect(insertSorted([m1, m2], m3, false)).toEqual([m1, m2, m3])
    expect(insertSorted([m1, m2], m2, false)).toEqual([m1, m2])
  })
  it('only prepends an older message when no unloaded history remains', () => {
    expect(insertSorted([m2, m3], m1, true)).toEqual([m2, m3])
    expect(insertSorted([m2, m3], m1, false)).toEqual([m1, m2, m3])
  })
})

describe('new messages line', () => {
  it('sits right before the marked message and splits its group', () => {
    const a = msg('peer', at(2026, 11, 5, 17, 0))
    const b = msg('peer', at(2026, 11, 5, 17, 1))
    const items = buildTimeline([a, b], NOW, [], [], b.id)
    expect(items.map((i) => i.kind)).toEqual(['day', 'group', 'new', 'group'])
  })
})

describe('reuseGroups', () => {
  const groupsOf = (items: ReturnType<typeof buildTimeline>) => items.filter((i) => i.kind === 'group')

  it('keeps unchanged groups and replaces only the one that changed', () => {
    const t = at(2026, 11, 5, 9, 0)
    const old = msg('peer', t)
    const last = msg('me', t + 60_000)
    const before = buildTimeline([old, last], NOW)
    const after = reuseGroups(before, buildTimeline([old, last, msg('me', t + 120_000)], NOW))
    expect(groupsOf(after)[0]).toBe(groupsOf(before)[0])
    expect(groupsOf(after)[1]).not.toBe(groupsOf(before)[1])
    expect((groupsOf(after)[1] as { messages: unknown[] }).messages).toHaveLength(2)
  })

  it('replaces a group when one of its messages changed', () => {
    const t = at(2026, 11, 5, 9, 0)
    const m = msg('me', t, 'sent')
    const before = buildTimeline([m], NOW)
    const after = reuseGroups(before, buildTimeline([{ ...m, status: 'read' }], NOW))
    expect(groupsOf(after)[0]).not.toBe(groupsOf(before)[0])
  })
})
