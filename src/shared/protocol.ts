// Wire protocol between two Hush apps (JSON text frames over one WebSocket).
//
// Sync model (stage c): every message carries its author's id and a per-author sequence
// number (1, 2, 3…). On each connection both sides send one `sync` frame:
//   have[author] = "I hold that author's messages 1…N without gaps"   (doubles as delivery ack)
//   read[author] = "I have read that author's messages up to N"        (doubles as read receipts)
// and each side then sends whatever the other is missing. Messages are stored by UUID, so
// re-sends never duplicate, and statuses only move forward. A future always-on relay node
// can take part by speaking the same frames.
//
// Images (stage d): a `msg` may carry `image` metadata plus a small inline preview. The
// receiver then *pulls* the full file with `blob-req {id, offset}`; the owner streams binary
// chunks (see encodeChunk). Pulling from an offset makes transfers resumable, and the SHA-256
// in the metadata lets the receiver reject a corrupted file.

export const PROTOCOL_VERSION = 3
export const DEFAULT_PORT = 47821
/** Upper bound for a single frame on the wire. */
export const MAX_FRAME_BYTES = 256 * 1024
/** Longest message body accepted, in UTF-16 code units. */
export const MAX_TEXT_LENGTH = 8000
const MAX_NAME_LENGTH = 40
const MAX_IDS_PER_FRAME = 500
const MAX_SYNC_AUTHORS = 16

export const IMAGE_MIME = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const
export type ImageMime = (typeof IMAGE_MIME)[number]
export const MAX_IMAGE_BYTES = 25 * 1024 * 1024
const MAX_IMAGE_SIDE = 20_000
/** Inline preview (base64 WebP/JPEG/PNG) must stay well inside one frame. */
const MAX_THUMB_BASE64 = 200_000
/** Bytes of image data per binary chunk. */
export const CHUNK_BYTES = 128 * 1024

export interface ImageMeta {
  mime: ImageMime
  width: number
  height: number
  size: number
  /** Hex SHA-256 of the full file. */
  sha256: string
}

export type Frame =
  /** First frame on every connection, from both sides. */
  | { t: 'hello'; v: number; id: string; name: string }
  /** Display name changed. */
  | { t: 'profile'; name: string }
  /** `body` may be empty when `image` is present (caption-less image). */
  | { t: 'msg'; id: string; author: string; seq: number; body: string; sentAt: number; image?: ImageMeta & { thumb: string } }
  /** "Send me the full image of message `id`, starting at byte `offset`." */
  | { t: 'blob-req'; id: string; offset: number }
  /** "I can't serve that image" (not mine, or the file is gone). */
  | { t: 'blob-err'; id: string }
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
const isInt = (v: unknown, min: number, max: number): v is number => Number.isSafeInteger(v) && (v as number) >= min && (v as number) <= max

export function parseImageMeta(v: unknown): ImageMeta | null {
  if (typeof v !== 'object' || v === null) return null
  const o = v as Record<string, unknown>
  if (!IMAGE_MIME.includes(o.mime as ImageMime)) return null
  if (!isInt(o.width, 1, MAX_IMAGE_SIDE) || !isInt(o.height, 1, MAX_IMAGE_SIDE) || !isInt(o.size, 1, MAX_IMAGE_BYTES)) return null
  if (typeof o.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(o.sha256)) return null
  return { mime: o.mime as ImageMime, width: o.width, height: o.height, size: o.size, sha256: o.sha256 }
}

function parseInlineImage(v: unknown): (ImageMeta & { thumb: string }) | null {
  const meta = parseImageMeta(v)
  const thumb = (v as Record<string, unknown> | null)?.thumb
  if (!meta || typeof thumb !== 'string' || thumb.length === 0 || thumb.length > MAX_THUMB_BASE64) return null
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(thumb)) return null
  return { ...meta, thumb }
}
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
  const f = parseRaw(raw)
  return f && lowercaseIds(f)
}

/** UUIDs are compared and used as file names in lowercase only. */
function lowercaseIds(f: Frame): Frame {
  const lc = (s: string): string => s.toLowerCase()
  switch (f.t) {
    case 'hello':
      return { ...f, id: lc(f.id) }
    case 'msg':
      return { ...f, id: lc(f.id), author: lc(f.author) }
    case 'ack':
      return { ...f, ids: f.ids.map(lc) }
    case 'read':
      return { ...f, author: lc(f.author) }
    case 'sync':
      return {
        ...f,
        have: Object.fromEntries(Object.entries(f.have).map(([k, v]) => [lc(k), v])),
        read: Object.fromEntries(Object.entries(f.read).map(([k, v]) => [lc(k), v]))
      }
    case 'blob-req':
    case 'blob-err':
      return { ...f, id: lc(f.id) }
    default:
      return f
  }
}

function parseRaw(raw: string): Frame | null {
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
    case 'msg': {
      const image = f.image === undefined ? undefined : parseInlineImage(f.image)
      if (image === null) return null
      const ok =
        isUuid(f.id) &&
        isUuid(f.author) &&
        isSeq(f.seq) &&
        typeof f.body === 'string' &&
        (f.body.length > 0 || image !== undefined) &&
        f.body.length <= MAX_TEXT_LENGTH &&
        Number.isSafeInteger(f.sentAt) &&
        (f.sentAt as number) > 0
      if (!ok) return null
      const msg: Frame = { t: 'msg', id: f.id as string, author: f.author as string, seq: f.seq as number, body: f.body as string, sentAt: f.sentAt as number }
      return image ? { ...msg, image } : msg
    }
    case 'blob-req':
      return isUuid(f.id) && isInt(f.offset, 0, MAX_IMAGE_BYTES) ? { t: 'blob-req', id: f.id, offset: f.offset } : null
    case 'blob-err':
      return isUuid(f.id) ? { t: 'blob-err', id: f.id } : null
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

// ---------- binary image chunks ----------
// Layout: 16 bytes message UUID | 4 bytes offset (uint32 BE) | data (≤ CHUNK_BYTES)

export interface Chunk {
  id: string
  offset: number
  data: Uint8Array
}

export function encodeChunk(id: string, offset: number, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(20 + data.length)
  const hex = id.replace(/-/g, '')
  for (let i = 0; i < 16; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  new DataView(out.buffer).setUint32(16, offset)
  out.set(data, 20)
  return out
}

export function decodeChunk(buf: Uint8Array): Chunk | null {
  if (buf.length <= 20 || buf.length > 20 + CHUNK_BYTES) return null
  const hex = Array.from(buf.subarray(0, 16), (b) => b.toString(16).padStart(2, '0')).join('')
  const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
  const offset = new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getUint32(16)
  return { id, offset, data: buf.subarray(20) }
}

/** Checks the file signature, so a file claiming to be an image really is one. */
export function sniffImage(bytes: Uint8Array): ImageMime | null {
  const b = bytes
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png'
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'image/gif'
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50)
    return 'image/webp'
  return null
}
