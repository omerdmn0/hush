import type { CallRecord, ChatMessage } from '../../../shared/types'
import { dayLabel, startOfDay } from './format'

/** Consecutive messages from the same sender within this window share one group (MASTER.md §6). */
export const GROUP_WINDOW_MS = 5 * 60 * 1000

/** "N queued messages delivered" line shown when the offline queue flushes. */
export interface DeliveryNotice {
  id: string
  at: number
  count: number
}

export type TimelineItem =
  | { kind: 'day'; key: string; label: string }
  | { kind: 'group'; key: string; from: ChatMessage['from']; messages: ChatMessage[] }
  | { kind: 'notice'; key: string; notice: DeliveryNotice }
  | { kind: 'call'; key: string; call: CallRecord }
  /** "New messages" line above the first message that arrived while you were away. */
  | { kind: 'new'; key: string }

/**
 * Turns a flat message list into date separators, sender groups and delivery notices.
 * A group breaks when the sender changes, the gap to the previous message exceeds
 * five minutes, the calendar day changes, or a notice sits in between.
 */
export function buildTimeline(
  messages: readonly ChatMessage[],
  now: number = Date.now(),
  notices: readonly DeliveryNotice[] = [],
  calls: readonly CallRecord[] = [],
  newMarkerId: string | null = null
): TimelineItem[] {
  type Entry = { at: number; tie: string; m?: ChatMessage; n?: DeliveryNotice; c?: CallRecord }
  const entries: Entry[] = [
    ...messages.map((m) => ({ at: m.sentAt, tie: `0${m.id}`, m })),
    ...calls.map((c) => ({ at: c.startedAt, tie: `1${c.id}`, c })),
    ...notices.map((n) => ({ at: n.at, tie: `2${n.id}`, n })) // notices sort last at the same ms
  ].sort((a, b) => a.at - b.at || a.tie.localeCompare(b.tie))
  const items: TimelineItem[] = []
  let day: number | null = null
  let group: Extract<TimelineItem, { kind: 'group' }> | null = null

  for (const e of entries) {
    const d = startOfDay(e.at)
    if (d !== day) {
      day = d
      group = null
      items.push({ kind: 'day', key: `day-${d}`, label: dayLabel(e.at, now) })
    }
    if (e.n) {
      group = null
      items.push({ kind: 'notice', key: `notice-${e.n.id}`, notice: e.n })
      continue
    }
    if (e.c) {
      group = null
      items.push({ kind: 'call', key: `call-${e.c.id}`, call: e.c })
      continue
    }
    const m = e.m!
    if (m.id === newMarkerId) {
      group = null
      items.push({ kind: 'new', key: 'new-messages' })
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

/**
 * Keeps the previous object for every group whose messages didn't change, so only the groups
 * that really changed re-render.
 */
export function reuseGroups(previous: readonly TimelineItem[], next: TimelineItem[]): TimelineItem[] {
  const old = new Map(previous.flatMap((it) => (it.kind === 'group' ? [[it.key, it] as const] : [])))
  return next.map((it) => {
    const before = it.kind === 'group' ? old.get(it.key) : undefined
    return it.kind === 'group' && before && before.messages.length === it.messages.length && before.messages.every((m, i) => m === it.messages[i]) ? before : it
  })
}

/** The most recent queued message of mine, under which the "waiting" note is shown. */
export function lastQueuedId(messages: readonly ChatMessage[]): string | null {
  let latest: ChatMessage | null = null
  for (const m of messages) {
    if (m.from === 'me' && m.status === 'queued' && (!latest || m.sentAt >= latest.sentAt)) latest = m
  }
  return latest?.id ?? null
}
