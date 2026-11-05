import { MAX_TEXT_LENGTH } from '../shared/protocol'
import type { Reaction } from '../shared/types'

/** An edit / delete / react event as stored (only the fields that matter here). */
export interface EventRecord {
  authorId: string
  seq: number | null
  sentAt: number
  kind?: string
  data?: string | null
}

export interface EventState {
  /** Latest edited text, if edited. */
  text?: string
  editedAt?: number
  deleted: boolean
  reactions: Reaction[]
}

/** One emoji (incl. skin tones, ZWJ sequences, flags), nothing else. */
export function isReactionEmoji(s: string): boolean {
  return s.length > 0 && s.length <= 32 && !/\s/u.test(s) && /\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(s)
}

/** "+🔥" adds a reaction, "-🔥" removes it. */
export function reactionData(emoji: string, on: boolean): string {
  return (on ? '+' : '-') + emoji
}

/**
 * What a message looks like after its events. Only the message's author may edit or delete it
 * (anything else is ignored, so a peer can't rewrite our words). Each person's events apply in
 * their own sequence order; reactions toggle per person, so both can react with several emoji.
 */
export function applyEvents(targetAuthor: string, events: readonly EventRecord[], selfId: string): EventState {
  const ordered = [...events].sort((a, b) => (a.authorId === b.authorId ? (a.seq ?? 0) - (b.seq ?? 0) : a.sentAt - b.sentAt))
  const state: EventState = { deleted: false, reactions: [] }
  const byPerson = new Map<string, Map<string, number>>() // author → emoji → when added
  let lastEdit = -1

  for (const e of ordered) {
    if (e.kind === 'delete' && e.authorId === targetAuthor) {
      state.deleted = true
    } else if (e.kind === 'edit' && e.authorId === targetAuthor && e.data && e.data.length <= MAX_TEXT_LENGTH && e.sentAt >= lastEdit) {
      state.text = e.data
      state.editedAt = e.sentAt
      lastEdit = e.sentAt
    } else if (e.kind === 'react' && e.data && (e.data[0] === '+' || e.data[0] === '-')) {
      const emoji = e.data.slice(1)
      if (!isReactionEmoji(emoji)) continue
      const mine = byPerson.get(e.authorId) ?? new Map<string, number>()
      byPerson.set(e.authorId, mine)
      if (e.data[0] === '+') {
        if (!mine.has(emoji)) mine.set(emoji, e.sentAt)
      } else {
        mine.delete(emoji)
      }
    }
  }
  if (state.deleted) return { deleted: true, reactions: [] }

  const first = new Map<string, number>()
  for (const set of byPerson.values()) for (const [emoji, at] of set) first.set(emoji, Math.min(first.get(emoji) ?? at, at))
  state.reactions = [...first.entries()]
    .sort((a, b) => a[1] - b[1])
    .map(([emoji]) => ({
      emoji,
      mine: byPerson.get(selfId)?.has(emoji) ?? false,
      theirs: [...byPerson.entries()].some(([who, set]) => who !== selfId && set.has(emoji))
    }))
  return state
}
