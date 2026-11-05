// Wire protocol between two Hush apps (JSON text frames over one WebSocket).
// Designed so a future always-on relay node can speak the same frames: messages carry
// their own UUID and author id, and every handler is idempotent.

export const PROTOCOL_VERSION = 1
export const DEFAULT_PORT = 47821
/** Upper bound for a single frame on the wire. */
export const MAX_FRAME_BYTES = 256 * 1024
/** Longest message body accepted, in UTF-16 code units. */
export const MAX_TEXT_LENGTH = 8000
const MAX_NAME_LENGTH = 40
const MAX_IDS_PER_FRAME = 500

export type Frame =
  /** First frame on every connection, from both sides. */
  | { t: 'hello'; v: number; id: string; name: string }
  /** Display name changed. */
  | { t: 'profile'; name: string }
  | { t: 'msg'; id: string; author: string; body: string; sentAt: number }
  /** "These messages are stored on my side" → sender marks them delivered. */
  | { t: 'ack'; ids: string[] }
  /** "I have seen these messages" → sender marks them read. */
  | { t: 'read'; ids: string[] }
  | { t: 'typing'; on: boolean }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID.test(v)

const isName = (v: unknown): v is string => typeof v === 'string' && v.length <= MAX_NAME_LENGTH
const isIdList = (v: unknown): v is string[] => Array.isArray(v) && v.length <= MAX_IDS_PER_FRAME && v.every(isUuid)

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
        typeof f.body === 'string' &&
        f.body.length > 0 &&
        f.body.length <= MAX_TEXT_LENGTH &&
        Number.isSafeInteger(f.sentAt) &&
        (f.sentAt as number) > 0
        ? { t: 'msg', id: f.id, author: f.author, body: f.body, sentAt: f.sentAt as number }
        : null
    case 'ack':
      return isIdList(f.ids) ? { t: 'ack', ids: f.ids } : null
    case 'read':
      return isIdList(f.ids) ? { t: 'read', ids: f.ids } : null
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
