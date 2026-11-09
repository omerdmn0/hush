import { describe, expect, it } from 'vitest'
import { parseRange } from './range'

describe('parseRange', () => {
  it('reads open-ended and bounded ranges', () => {
    expect(parseRange('bytes=0-', 100)).toEqual({ start: 0, end: 99 })
    expect(parseRange('bytes=10-19', 100)).toEqual({ start: 10, end: 19 })
  })

  it('stops at the end of the file', () => {
    expect(parseRange('bytes=90-500', 100)).toEqual({ start: 90, end: 99 })
  })

  it('falls back to the whole file for anything it can’t serve', () => {
    for (const header of [null, '', 'bytes=-5', 'bytes=0-1,5-6', 'items=0-1', 'bytes=100-', 'bytes=20-10']) expect(parseRange(header, 100), String(header)).toBeNull()
  })
})
