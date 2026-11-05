import type { ChatMessage } from '../../../shared/types'
import { dayLabel, startOfDay } from './format'

/** Consecutive messages from the same sender within this window share one group (MASTER.md §6). */
export const GROUP_WINDOW_MS = 5 * 60 * 1000

export type TimelineItem =
  | { kind: 'day'; key: string; label: string }
  | { kind: 'group'; key: string; from: ChatMessage['from']; messages: ChatMessage[] }

/**
 * Turns a flat message list into date separators and sender groups.
 * A group breaks when the sender changes, the gap to the previous message exceeds
 * five minutes, or the calendar day changes.
 */
export function buildTimeline(messages: readonly ChatMessage[], now: number = Date.now()): TimelineItem[] {
  const sorted = [...messages].sort((a, b) => a.sentAt - b.sentAt || a.id.localeCompare(b.id))
  const items: TimelineItem[] = []
  let day: number | null = null
  let group: Extract<TimelineItem, { kind: 'group' }> | null = null

  for (const m of sorted) {
    const d = startOfDay(m.sentAt)
    if (d !== day) {
      day = d
      group = null
      items.push({ kind: 'day', key: `day-${d}`, label: dayLabel(m.sentAt, now) })
    }
    const prev = group?.messages[group.messages.length - 1]
    if (group && prev && group.from === m.from && m.sentAt - prev.sentAt <= GROUP_WINDOW_MS) {
      group.messages.push(m)
    } else {
      group = { kind: 'group', key: `group-${m.id}`, from: m.from, messages: [m] }
      items.push(group)
    }
  }
  return items
}

/** The most recent queued message of mine, under which the "waiting" note is shown. */
export function lastQueuedId(messages: readonly ChatMessage[]): string | null {
  let latest: ChatMessage | null = null
  for (const m of messages) {
    if (m.from === 'me' && m.status === 'queued' && (!latest || m.sentAt >= latest.sentAt)) latest = m
  }
  return latest?.id ?? null
}
