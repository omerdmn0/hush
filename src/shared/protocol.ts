// Wire protocol between two Hush apps (JSON text frames over one WebSocket).
//
// Sync model (stage c): every message carries its author's id and a per-author sequence
// number (1, 2, 3…). On each connection both sides send one `sync` frame:
//   have[author] = "I hold that author's messages 1…N without gaps"   (doubles as delivery ack)
//   read[author] = "I have read that author's messages up to N"        (doubles as read receipts)
// and each side then sends whatever the other is missing. Messages are stored by UUID, so
// re-sends never duplicate, and statuses only move forward. A future always-on relay node
// can take part by speaking the same frames.

export const PROTOCOL_VERSION = 2
export const DEFAULT_PORT = 47821
/** Upper bound for a single frame on the wire. */
export const MAX_FRAME_BYTES = 256 * 1024
/** Longest message body accepted, in UTF-16 code units. */
export const MAX_TEXT_LENGTH = 8000
const MAX_NAME_LENGTH = 40
const MAX_IDS_PER_FRAME = 500
const MAX_SYNC_AUTHORS = 16

export type Frame =
  /** First frame on every connection, from both sides. */
  | { t: 'hello'; v: number; id: string; name: string }
  /** Display name changed. */
  | { t: 'profile'; name: string }
  | { t: 'msg'; id: string; author: string; seq: number; body: string; sentAt: number }
  /** Sent once per connection by both sides; see the sync model above. */
  | { t: 'sync'; have: Record<string, number>; read: Record<string, number> }
  /** "These messages are stored on my side" → sender marks them delivered. */
  | { t: 'ack'; ids: string[] }
  /** "I have read `author`'s messages up to seq `upTo`" → sender marks them read. */
  | { t: 'read'; author: string; upTo: number }
  | { t: 'typing'; on: boolean }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID.test(v)

const isName = (v: unknown): v is string => typeof v === 'string' && v.length <= MAX_NAME_LENGTH
const isIdList = (v: unknown): v is string[] => Array.isArray(v) && v.length <= MAX_IDS_PER_FRAME && v.every(isUuid)
const isSeq = (v: unknown, min = 1): v is number => Number.isSafeInteger(v) && (v as number) >= min
/** { [authorUuid]: seq ≥ 0 }, small and strictly shaped. */
function seqMap(v: unknown): Record<string, number> | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null
  const entries = Object.entries(v)
  if (entries.length > MAX_SYNC_AUTHORS) return null
  const out: Record<string, number> = {}
  for (const [k, n] of entries) {
    if (!isUuid(k) || !isSeq(n, 0)) return null
    out[k] = n
  }
  return out
}

/** Parses and validates one frame. Anything malformed returns null and is dropped. */
export function parseFrame(raw: string): Frame | null {
  if (raw.length > MAX_FRAME_BYTES) return null
  let f: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
    f = parsed as Record<string, unknown>
  } catch {
    return null
  }
  switch (f.t) {
    case 'hello':
      return typeof f.v === 'number' && isUuid(f.id) && isName(f.name) ? { t: 'hello', v: f.v, id: f.id, name: f.name } : null
    case 'profile':
      return isName(f.name) ? { t: 'profile', name: f.name } : null
    case 'msg':
      return isUuid(f.id) &&
        isUuid(f.author) &&
        isSeq(f.seq) &&
        typeof f.body === 'string' &&
        f.body.length > 0 &&
        f.body.length <= MAX_TEXT_LENGTH &&
        Number.isSafeInteger(f.sentAt) &&
        (f.sentAt as number) > 0
        ? { t: 'msg', id: f.id, author: f.author, seq: f.seq, body: f.body, sentAt: f.sentAt as number }
        : null
    case 'sync': {
      const have = seqMap(f.have)
      const read = seqMap(f.read)
      return have && read ? { t: 'sync', have, read } : null
    }
    case 'ack':
      return isIdList(f.ids) ? { t: 'ack', ids: f.ids } : null
    case 'read':
      return isUuid(f.author) && isSeq(f.upTo, 0) ? { t: 'read', author: f.author, upTo: f.upTo } : null
    case 'typing':
      return typeof f.on === 'boolean' ? { t: 'typing', on: f.on } : null
    default:
      return null
  }
}

/** Splits a long id list into frames that respect MAX_IDS_PER_FRAME. */
export function chunkIds(ids: readonly string[]): string[][] {
  const out: string[][] = []
  for (let i = 0; i < ids.length; i += MAX_IDS_PER_FRAME) out.push(ids.slice(i, i + MAX_IDS_PER_FRAME))
  return out
}
