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
//
// Calls (stage e): WebRTC signaling rides on the same link — `call` (offer), `call-ringing`,
// `call-answer`, `call-ice`, `call-end`. Media then flows peer-to-peer (DTLS-SRTP), restricted
// to Tailscale addresses; no STUN/TURN servers are used.
//
// Avatars (stage f): `avatar` carries the sender's small profile picture (or null = removed);
// it is sent on every connection and whenever it changes.

//
// Compatibility (stage h): from protocol 6 on, versions stay compatible. Each app announces its
// version and `features` in `hello`; frames it doesn't know are ignored, and message kinds it
// doesn't know are shown as "update Hush to see this". Only apps older than MIN_PROTOCOL are refused.
//
// Identity (stage h): each install has an Ed25519 key, sent in `hello` with a random nonce. Once
// paired, every connection proves the pinned key by signing the other side's nonce (`auth`).
// Pairing: each app shows a one-time code the other person types; `pair-proof` is an HMAC with
// that code over both public keys, so only someone who saw the screen can produce it.

export const PROTOCOL_VERSION = 6
/** Oldest protocol this app still talks to. */
export const MIN_PROTOCOL = 6
/** Features this app supports (announced in hello). */
export const FEATURES = ['images', 'calls', 'avatars', 'events', 'recover'] as const
/** Message kinds that act on another message (they carry `ref`). */
export const EVENT_KINDS = ['edit', 'delete', 'react'] as const
const MAX_EVENT_DATA = 2_000
/** Largest avatar image accepted (already a 256 px square, so this is generous). */
export const MAX_AVATAR_BYTES = 96 * 1024
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
const MAX_SDP = 32_000
const MAX_CANDIDATE = 1_024
export const CALL_END_REASONS = ['hangup', 'declined', 'busy', 'cancelled', 'timeout', 'failed'] as const
export type CallEndReason = (typeof CALL_END_REASONS)[number]

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
  /** `pinned` = the key the sender has paired with ('' if none), so both sides agree on pairing state. */
  | { t: 'hello'; v: number; id: string; name: string; app: string; features: string[]; key: string; nonce: string; pinned: string }
  /** Signature over the other side's nonce, proving we hold the pinned identity key. */
  | { t: 'auth'; sig: string }
  /** "I typed your pairing code": HMAC(code, "hush-pair-v1|ownerKey|typerKey"). */
  | { t: 'pair-proof'; mac: string }
  /** Answer to a pair-proof. */
  | { t: 'pair-result'; ok: boolean; attemptsLeft: number }
  /** Display name changed. */
  | { t: 'profile'; name: string }
  /**
   * An authored item in the per-author sequence. kind 'message' (default) is a chat message —
   * `body` may be empty when it carries an image. Other kinds are events on message `ref`
   * (edit / delete / react) with their payload in `data`.
   */
  | {
      t: 'msg'
      id: string
      author: string
      seq: number
      body: string
      sentAt: number
      image?: ImageMeta & { thumb: string }
      kind?: string
      ref?: string
      data?: string
    }
  /** "Send me the full image of message `id`, starting at byte `offset`." */
  | { t: 'blob-req'; id: string; offset: number }
  /** "I can't serve that image" (not mine, or the file is gone). */
  | { t: 'blob-err'; id: string }
  /** Call invitation carrying the caller's SDP offer. */
  | { t: 'call'; id: string; sdp: string }
  /** The callee's app received the invitation and is ringing. */
  | { t: 'call-ringing'; id: string }
  | { t: 'call-answer'; id: string; sdp: string }
  | { t: 'call-ice'; id: string; candidate: string; mid: string | null; line: number | null }
  | { t: 'call-end'; id: string; reason: CallEndReason }
  /** Sender's profile picture as base64 PNG/JPEG/WebP, or null when removed. */
  | { t: 'avatar'; data: string | null }
  /** Sent once per connection by both sides; see the sync model above. */
  | { t: 'sync'; have: Record<string, number>; read: Record<string, number> }
  /** "These messages are stored on my side" → sender marks them delivered. */
  | { t: 'ack'; ids: string[] }
  /** "I have read `author`'s messages up to seq `upTo`" → sender marks them read. */
  | { t: 'read'; author: string; upTo: number }
  | { t: 'typing'; on: boolean }
  /** A fresh install asks for its previous device id, to take over its old history. */
  | { t: 'recover-req' }
  /** The answer: the id we knew before (null if none) and its highest sequence number. */
  | { t: 'recover'; id: string | null; seq: number }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID.test(v)

const isName = (v: unknown): v is string => typeof v === 'string' && v.length <= MAX_NAME_LENGTH
const isIdList = (v: unknown): v is string[] => Array.isArray(v) && v.length <= MAX_IDS_PER_FRAME && v.every(isUuid)
const isB64url = (v: unknown, min: number, max: number): v is string =>
  typeof v === 'string' && v.length >= min && v.length <= max && /^[A-Za-z0-9_-]+$/.test(v)
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
      if (f.ref) return { ...f, id: lc(f.id), author: lc(f.author), ref: lc(f.ref) }
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
    case 'call':
    case 'call-ringing':
    case 'call-answer':
    case 'call-ice':
    case 'call-end':
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
    case 'hello': {
      const ok =
        Number.isSafeInteger(f.v) &&
        isUuid(f.id) &&
        isName(f.name) &&
        typeof f.app === 'string' &&
        /^\d+\.\d+\.\d+[\w.-]*$/.test(f.app) &&
        f.app.length <= 32 &&
        Array.isArray(f.features) &&
        f.features.length <= 64 &&
        f.features.every((x) => typeof x === 'string' && /^[a-z0-9-]{1,32}$/.test(x)) &&
        isB64url(f.key, 43, 43) &&
        isB64url(f.nonce, 22, 64) &&
        (f.pinned === '' || isB64url(f.pinned, 43, 43))
      return ok
        ? {
            t: 'hello',
            v: f.v as number,
            id: f.id as string,
            name: f.name as string,
            app: f.app as string,
            features: f.features as string[],
            key: f.key as string,
            nonce: f.nonce as string,
            pinned: f.pinned as string
          }
        : null
    }
    case 'auth':
      return isB64url(f.sig, 86, 86) ? { t: 'auth', sig: f.sig } : null
    case 'pair-proof':
      return isB64url(f.mac, 43, 43) ? { t: 'pair-proof', mac: f.mac } : null
    case 'pair-result':
      return typeof f.ok === 'boolean' && isInt(f.attemptsLeft, 0, 10) ? { t: 'pair-result', ok: f.ok, attemptsLeft: f.attemptsLeft } : null
    case 'profile':
      return isName(f.name) ? { t: 'profile', name: f.name } : null
    case 'msg': {
      const image = f.image === undefined ? undefined : parseInlineImage(f.image)
      if (image === null) return null
      const kind = f.kind === undefined ? 'message' : f.kind
      if (typeof kind !== 'string' || !/^[a-z][a-z0-9-]{0,23}$/.test(kind)) return null
      if (f.ref !== undefined && !isUuid(f.ref)) return null
      if (f.data !== undefined && (typeof f.data !== 'string' || f.data.length > MAX_EVENT_DATA)) return null
      // Events act on another message; a chat message needs text or an image. Unknown kinds
      // from a newer Hush are accepted as long as they're well-formed (forward compatibility).
      if ((EVENT_KINDS as readonly string[]).includes(kind) && f.ref === undefined) return null
      const ok =
        isUuid(f.id) &&
        isUuid(f.author) &&
        isSeq(f.seq) &&
        typeof f.body === 'string' &&
        (kind !== 'message' || f.body.length > 0 || image !== undefined) &&
        f.body.length <= MAX_TEXT_LENGTH &&
        Number.isSafeInteger(f.sentAt) &&
        (f.sentAt as number) > 0
      if (!ok) return null
      const msg: Extract<Frame, { t: 'msg' }> = { t: 'msg', id: f.id as string, author: f.author as string, seq: f.seq as number, body: f.body as string, sentAt: f.sentAt as number }
      if (image) msg.image = image
      if (kind !== 'message') msg.kind = kind
      if (f.ref !== undefined) msg.ref = f.ref as string
      if (f.data !== undefined) msg.data = f.data as string
      return msg
    }
    case 'blob-req':
      return isUuid(f.id) && isInt(f.offset, 0, MAX_IMAGE_BYTES) ? { t: 'blob-req', id: f.id, offset: f.offset } : null
    case 'blob-err':
      return isUuid(f.id) ? { t: 'blob-err', id: f.id } : null
    case 'call':
    case 'call-answer':
      return isUuid(f.id) && typeof f.sdp === 'string' && f.sdp.length > 0 && f.sdp.length <= MAX_SDP
        ? { t: f.t, id: f.id, sdp: f.sdp }
        : null
    case 'call-ringing':
      return isUuid(f.id) ? { t: 'call-ringing', id: f.id } : null
    case 'call-ice':
      return isUuid(f.id) &&
        typeof f.candidate === 'string' &&
        f.candidate.length <= MAX_CANDIDATE &&
        (f.mid === null || (typeof f.mid === 'string' && f.mid.length <= 64)) &&
        (f.line === null || isInt(f.line, 0, 64))
        ? { t: 'call-ice', id: f.id, candidate: f.candidate, mid: f.mid as string | null, line: f.line as number | null }
        : null
    case 'avatar':
      return f.data === null ||
        (typeof f.data === 'string' && f.data.length > 0 && f.data.length <= Math.ceil(MAX_AVATAR_BYTES / 3) * 4 && /^[A-Za-z0-9+/]+={0,2}$/.test(f.data))
        ? { t: 'avatar', data: f.data as string | null }
        : null
    case 'call-end':
      return isUuid(f.id) && CALL_END_REASONS.includes(f.reason as CallEndReason)
        ? { t: 'call-end', id: f.id, reason: f.reason as CallEndReason }
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
    case 'recover-req':
      return { t: 'recover-req' }
    case 'recover':
      return (f.id === null || isUuid(f.id)) && isSeq(f.seq, 0) ? { t: 'recover', id: f.id, seq: f.seq } : null
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

export type CallSignal = Extract<Frame, { t: 'call' | 'call-ringing' | 'call-answer' | 'call-ice' | 'call-end' }>

export const isCallSignal = (f: Frame): f is CallSignal => f.t === 'call' || f.t.startsWith('call-')
