import { describe, expect, it } from 'vitest'
import { chunkIds, MAX_TEXT_LENGTH, parseFrame } from './protocol'

const A = '2f1c3a52-9d1e-4c4b-8a1f-0b6c2d3e4f50'
const B = '8a7b6c5d-4e3f-4a1b-9c2d-1e0f2a3b4c5d'
const j = (o: unknown): string => JSON.stringify(o)

describe('parseFrame', () => {
  it('accepts each valid frame type', () => {
    expect(parseFrame(j({ t: 'hello', v: 1, id: A, name: 'Mira' }))).toEqual({ t: 'hello', v: 1, id: A, name: 'Mira' })
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
    expect(parseFrame(j({ t: 'hello', v: 1, id: A, name: 'x'.repeat(41) }))).toBeNull()
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
