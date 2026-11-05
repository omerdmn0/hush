import { describe, expect, it } from 'vitest'
import { CHUNK_BYTES, chunkIds, decodeChunk, encodeChunk, MAX_TEXT_LENGTH, parseFrame, sniffImage } from './protocol'

const A = '2f1c3a52-9d1e-4c4b-8a1f-0b6c2d3e4f50'
const B = '8a7b6c5d-4e3f-4a1b-9c2d-1e0f2a3b4c5d'
const j = (o: unknown): string => JSON.stringify(o)

describe('parseFrame', () => {
  it('accepts each valid frame type', () => {
    const hello = { t: 'hello', v: 6, id: A, name: 'Mira', app: '0.2.0', features: ['events', 'files'], key: 'kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk', nonce: 'n'.repeat(43), pinned: '' }
    expect(parseFrame(j(hello))).toEqual(hello)
    expect(parseFrame(j({ ...hello, v: 9, features: ['something-new'] }))).toMatchObject({ v: 9 }) // newer apps are accepted
    expect(parseFrame(j({ ...hello, key: 'short' }))).toBeNull()
    expect(parseFrame(j({ t: 'auth', sig: 's'.repeat(86) }))).toEqual({ t: 'auth', sig: 's'.repeat(86) })
    expect(parseFrame(j({ t: 'pair-proof', mac: 'm'.repeat(43) }))).toEqual({ t: 'pair-proof', mac: 'm'.repeat(43) })
    expect(parseFrame(j({ t: 'pair-result', ok: false, attemptsLeft: 3 }))).toEqual({ t: 'pair-result', ok: false, attemptsLeft: 3 })
    expect(parseFrame(j({ t: 'msg', id: A, author: B, seq: 2, body: '', sentAt: 1, kind: 'react', ref: A, data: '🔥' }))).toMatchObject({ kind: 'react', ref: A })
    expect(parseFrame(j({ t: 'msg', id: A, author: B, seq: 2, body: '', sentAt: 1, kind: 'react' }))).toBeNull() // events need a ref
    expect(parseFrame(j({ t: 'brand-new-frame', x: 1 }))).toBeNull() // unknown frames are ignored
    expect(parseFrame(j({ t: 'profile', name: 'Ömer' }))).toEqual({ t: 'profile', name: 'Ömer' })
    expect(parseFrame(j({ t: 'msg', id: A, author: B, seq: 3, body: 'hi', sentAt: 1700000000000 }))).toMatchObject({ t: 'msg', seq: 3, body: 'hi' })
    expect(parseFrame(j({ t: 'sync', have: { [A]: 4, [B]: 0 }, read: { [B]: 2 } }))).toEqual({ t: 'sync', have: { [A]: 4, [B]: 0 }, read: { [B]: 2 } })
    expect(parseFrame(j({ t: 'ack', ids: [A, B] }))).toEqual({ t: 'ack', ids: [A, B] })
    expect(parseFrame(j({ t: 'read', author: A, upTo: 7 }))).toEqual({ t: 'read', author: A, upTo: 7 })
    expect(parseFrame(j({ t: 'typing', on: true }))).toEqual({ t: 'typing', on: true })
  })

  it('drops extra fields instead of passing them through', () => {
    expect(parseFrame(j({ t: 'typing', on: false, evil: 1 }))).toEqual({ t: 'typing', on: false })
  })

  it('rejects malformed input', () => {
    expect(parseFrame('not json')).toBeNull()
    expect(parseFrame('[1,2]')).toBeNull()
    expect(parseFrame('null')).toBeNull()
    expect(parseFrame(j({ t: 'unknown' }))).toBeNull()
    expect(parseFrame(j({ t: 'msg', id: 'nope', author: B, seq: 1, body: 'x', sentAt: 1 }))).toBeNull()
    expect(parseFrame(j({ t: 'msg', id: A, author: B, seq: 1, body: '', sentAt: 1 }))).toBeNull()
    expect(parseFrame(j({ t: 'msg', id: A, author: B, seq: 1, body: 'x', sentAt: -5 }))).toBeNull()
    expect(parseFrame(j({ t: 'msg', id: A, author: B, seq: 0, body: 'x', sentAt: 1 }))).toBeNull()
    expect(parseFrame(j({ t: 'msg', id: A, author: B, body: 'x', sentAt: 1 }))).toBeNull()
    expect(parseFrame(j({ t: 'msg', id: A, author: B, seq: 1, body: 'x'.repeat(MAX_TEXT_LENGTH + 1), sentAt: 1 }))).toBeNull()
    expect(parseFrame(j({ t: 'sync', have: { 'not-a-uuid': 1 }, read: {} }))).toBeNull()
    expect(parseFrame(j({ t: 'sync', have: { [A]: -1 }, read: {} }))).toBeNull()
    expect(parseFrame(j({ t: 'sync', have: [], read: {} }))).toBeNull()
    expect(parseFrame(j({ t: 'read', ids: [A] }))).toBeNull() // v1 shape is no longer accepted
    expect(parseFrame(j({ t: 'hello', v: 6, id: A, name: 'x'.repeat(41) }))).toBeNull()
    expect(parseFrame(j({ t: 'ack', ids: [A, 'bad'] }))).toBeNull()
    expect(parseFrame(j({ t: 'typing', on: 'yes' }))).toBeNull()
  })
})

describe('chunkIds', () => {
  it('splits into chunks of at most 500', () => {
    const ids = Array.from({ length: 1201 }, () => A)
    expect(chunkIds(ids).map((c) => c.length)).toEqual([500, 500, 201])
    expect(chunkIds([])).toEqual([])
  })
})

describe('images', () => {
  const meta = { mime: 'image/png', width: 800, height: 600, size: 12345, sha256: 'a'.repeat(64) }
  it('accepts a message with an inline preview and an empty caption', () => {
    const f = parseFrame(j({ t: 'msg', id: A, author: B, seq: 1, body: '', sentAt: 1, image: { ...meta, thumb: 'UklGRg==' } }))
    expect(f).toMatchObject({ t: 'msg', body: '', image: { mime: 'image/png', thumb: 'UklGRg==' } })
  })
  it('rejects bad image metadata', () => {
    const bad = (image: unknown): unknown => parseFrame(j({ t: 'msg', id: A, author: B, seq: 1, body: '', sentAt: 1, image }))
    expect(bad({ ...meta, mime: 'image/svg+xml', thumb: 'AA==' })).toBeNull()
    expect(bad({ ...meta, size: 26 * 1024 * 1024, thumb: 'AA==' })).toBeNull()
    expect(bad({ ...meta, sha256: 'xyz', thumb: 'AA==' })).toBeNull()
    expect(bad({ ...meta, thumb: 'not base64!' })).toBeNull()
    expect(bad({ ...meta })).toBeNull() // preview required
    expect(parseFrame(j({ t: 'msg', id: A, author: B, seq: 1, body: '', sentAt: 1 }))).toBeNull() // empty without image
  })
  it('validates blob requests', () => {
    expect(parseFrame(j({ t: 'blob-req', id: A, offset: 131072 }))).toEqual({ t: 'blob-req', id: A, offset: 131072 })
    expect(parseFrame(j({ t: 'blob-req', id: A, offset: -1 }))).toBeNull()
    expect(parseFrame(j({ t: 'blob-err', id: A }))).toEqual({ t: 'blob-err', id: A })
  })
  it('round-trips binary chunks and rejects oversized ones', () => {
    const data = new Uint8Array([1, 2, 3, 250])
    const c = decodeChunk(encodeChunk(A, 393216, data))
    expect(c).toEqual({ id: A, offset: 393216, data })
    expect(decodeChunk(new Uint8Array(20))).toBeNull()
    expect(decodeChunk(new Uint8Array(20 + CHUNK_BYTES + 1))).toBeNull()
  })
  it('recognises image signatures', () => {
    expect(sniffImage(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe('image/png')
    expect(sniffImage(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg')
    expect(sniffImage(new TextEncoder().encode('GIF89a'))).toBe('image/gif')
    expect(sniffImage(new TextEncoder().encode('RIFF\0\0\0\0WEBPVP8 '))).toBe('image/webp')
    expect(sniffImage(new TextEncoder().encode('<svg xmlns='))).toBeNull()
  })
})

describe('call signaling', () => {
  it('accepts valid call frames', () => {
    expect(parseFrame(j({ t: 'call', id: A, sdp: 'v=0' }))).toEqual({ t: 'call', id: A, sdp: 'v=0' })
    expect(parseFrame(j({ t: 'call-answer', id: A, sdp: 'v=0' }))).toMatchObject({ t: 'call-answer' })
    expect(parseFrame(j({ t: 'call-ringing', id: A }))).toEqual({ t: 'call-ringing', id: A })
    expect(parseFrame(j({ t: 'call-ice', id: A, candidate: 'candidate:1 1 udp 1 100.64.0.1 5000 typ host', mid: '0', line: 0 }))).toMatchObject({ t: 'call-ice', mid: '0' })
    expect(parseFrame(j({ t: 'call-ice', id: A, candidate: '', mid: null, line: null }))).toMatchObject({ t: 'call-ice', candidate: '' })
    expect(parseFrame(j({ t: 'call-end', id: A, reason: 'declined' }))).toEqual({ t: 'call-end', id: A, reason: 'declined' })
  })
  it('rejects malformed call frames', () => {
    expect(parseFrame(j({ t: 'call', id: A, sdp: '' }))).toBeNull()
    expect(parseFrame(j({ t: 'call', id: A, sdp: 'x'.repeat(32_001) }))).toBeNull()
    expect(parseFrame(j({ t: 'call-ice', id: A, candidate: 'x'.repeat(1025), mid: null, line: null }))).toBeNull()
    expect(parseFrame(j({ t: 'call-ice', id: A, candidate: 'c', mid: 5, line: 0 }))).toBeNull()
    expect(parseFrame(j({ t: 'call-end', id: A, reason: 'exploded' }))).toBeNull()
  })
})

describe('avatar frames', () => {
  it('accepts a base64 picture or null, and rejects oversized or malformed data', () => {
    expect(parseFrame(j({ t: 'avatar', data: 'UklGRg==' }))).toEqual({ t: 'avatar', data: 'UklGRg==' })
    expect(parseFrame(j({ t: 'avatar', data: null }))).toEqual({ t: 'avatar', data: null })
    expect(parseFrame(j({ t: 'avatar', data: 'A'.repeat(140_000) }))).toBeNull()
    expect(parseFrame(j({ t: 'avatar', data: '<svg>' }))).toBeNull()
    expect(parseFrame(j({ t: 'avatar' }))).toBeNull()
  })
})
